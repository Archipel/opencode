import { createStore } from "solid-js/store"
import { dirname } from "node:path"
import { execFile } from "node:child_process"
import { createMemo, For, Match, Show, Switch } from "solid-js"
import { Portal, useRenderer, useTerminalDimensions, type JSX } from "@opentui/solid"
import type { TextareaRenderable } from "@opentui/core"
import { useTheme, selectedForeground } from "../../context/theme"
import type { PermissionRequest } from "@opencode-ai/sdk/v2"
import { useSDK } from "../../context/sdk"
import { SplitBorder } from "../../ui/border"
import { useSync } from "../../context/sync"
import { useProject } from "../../context/project"
import { filetype } from "../../util/filetype"
import { Locale } from "../../util/locale"
import { webSearchProviderLabel } from "../../util/tool-display"
import { getScrollAcceleration } from "../../util/scroll"
import { useTuiConfig } from "../../config"
import { OPENCODE_BASE_MODE, useBindings, useCommandShortcut } from "../../keymap"
import { usePathFormatter } from "../../context/path-format"

type PermissionStage = "permission" | "always" | "reject" | "investigate" | "result" | "discuss"

// Result of `ai-sessions gate investigate --cmd … --json` (see gate_investigate.rs).
type Investigation = {
  command: string
  verdict: "propose" | "no-rule" | "unsafe"
  reasoning: string
  rule?: { regex: string; note?: string; rejected_reason?: string }
  matcher_suggestion?: string
  model: string
}

const AI_SESSIONS_CANDIDATES = [
  `${process.env.HOME}/bin/ai-sessions`,
  `${process.env.HOME}/.claude/bin/ai-sessions`,
  "ai-sessions",
]

let aiSessionsBin: string | undefined

async function resolveAiSessions(): Promise<string> {
  if (aiSessionsBin) return aiSessionsBin
  for (const bin of AI_SESSIONS_CANDIDATES) {
    // --help is fast and local (no DB open, no Windows delegation).
    const found = await new Promise<boolean>((resolve) => {
      execFile(bin, ["--help"], { timeout: 5_000 }, (err) => resolve(!err))
    }).catch(() => false)
    if (found) {
      aiSessionsBin = bin
      return bin
    }
  }
  throw new Error("ai-sessions CLI not found (tried ~/bin/ai-sessions and PATH)")
}

function runAiSessions(args: string[], timeout: number): Promise<string> {
  return resolveAiSessions().then(
    (bin) =>
      new Promise<string>((resolve, reject) => {
        execFile(bin, args, { timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) =>
          err ? reject(err instanceof Error ? err : new Error(String(err))) : resolve(stdout),
        )
      }),
  )
}

function investigateCommand(command: string): Promise<Investigation> {
  return runAiSessions(["gate", "investigate", "--cmd", command, "--json"], 180_000).then((stdout) => {
    const parsed = JSON.parse(stdout) as Investigation
    if (!parsed || typeof parsed.reasoning !== "string") throw new Error("malformed investigation reply")
    return parsed
  })
}

function EditBody(props: { request: PermissionRequest }) {
  const themeState = useTheme()
  const theme = themeState.theme
  const syntax = themeState.syntax
  const config = useTuiConfig()
  const dimensions = useTerminalDimensions()

  const filepath = createMemo(() => {
    const value = props.request.metadata?.filepath
    return typeof value === "string" ? value : ""
  })
  const diff = createMemo(() => {
    const value = props.request.metadata?.diff
    return typeof value === "string" ? value : ""
  })

  const view = createMemo(() => {
    const diffStyle = config.diff_style
    if (diffStyle === "stacked") return "unified"
    return dimensions().width > 120 ? "split" : "unified"
  })

  const ft = createMemo(() => filetype(filepath()))
  const scrollAcceleration = createMemo(() => getScrollAcceleration(config))

  return (
    <box flexDirection="column" gap={1}>
      <Show when={diff()}>
        <scrollbox
          height="100%"
          scrollAcceleration={scrollAcceleration()}
          verticalScrollbarOptions={{
            trackOptions: {
              backgroundColor: theme.background,
              foregroundColor: theme.borderActive,
            },
          }}
        >
          <diff
            diff={diff()}
            view={view()}
            filetype={ft()}
            syntaxStyle={syntax()}
            showLineNumbers={true}
            width="100%"
            wrapMode="word"
            fg={theme.text}
            addedBg={theme.diffAddedBg}
            removedBg={theme.diffRemovedBg}
            contextBg={theme.diffContextBg}
            addedSignColor={theme.diffHighlightAdded}
            removedSignColor={theme.diffHighlightRemoved}
            lineNumberFg={theme.diffLineNumber}
            lineNumberBg={theme.diffContextBg}
            addedLineNumberBg={theme.diffAddedLineNumberBg}
            removedLineNumberBg={theme.diffRemovedLineNumberBg}
          />
        </scrollbox>
      </Show>
      <Show when={!diff()}>
        <box paddingLeft={1}>
          <text fg={theme.textMuted}>No diff provided</text>
        </box>
      </Show>
    </box>
  )
}

function TextBody(props: { title: string; description?: string; icon?: string }) {
  const { theme } = useTheme()
  return (
    <>
      <box flexDirection="row" gap={1} paddingLeft={1}>
        <Show when={props.icon}>
          <text fg={theme.textMuted} flexShrink={0}>
            {props.icon}
          </text>
        </Show>
        <text fg={theme.textMuted}>{props.title}</text>
      </box>
      <Show when={props.description}>
        <box paddingLeft={1}>
          <text fg={theme.text}>{props.description}</text>
        </box>
      </Show>
    </>
  )
}

export function PermissionPrompt(props: { request: PermissionRequest; directory?: string }) {
  const sdk = useSDK()
  const project = useProject()
  const sync = useSync()
  const [store, setStore] = createStore({
    stage: "permission" as PermissionStage,
    investigating: false,
    investError: "",
    investigation: null as Investigation | null,
    discussAction: "once" as "once" | "reject",
  })
  const pathFormatter = usePathFormatter()

  const session = createMemo(() => sync.data.session.find((s) => s.id === props.request.sessionID))

  const input = createMemo(() => {
    const tool = props.request.tool
    if (!tool) return {}
    const parts = sync.data.part[tool.messageID] ?? []
    for (const part of parts) {
      if (part.type === "tool" && part.callID === tool.callID && part.state.status !== "pending") {
        return part.state.input ?? {}
      }
    }
    return {}
  })

  const { theme } = useTheme()

  const bashCommand = createMemo(() => {
    if (props.request.permission !== "bash") return ""
    const raw = input().command
    if (typeof raw === "string" && raw) return raw
    const meta = props.request.metadata?.command
    return typeof meta === "string" ? meta : ""
  })

  const replyOnce = () =>
    sdk.client.permission.reply({
      reply: "once",
      requestID: props.request.id,
      directory: props.directory,
      workspace: project.workspace.current(),
    })
  const replyReject = (message?: string) =>
    sdk.client.permission.reply({
      reply: "reject",
      message: message || undefined,
      requestID: props.request.id,
      directory: props.directory,
      workspace: project.workspace.current(),
    })

  const startInvestigate = async () => {
    const command = bashCommand()
    if (!command || store.investigating) return
    setStore({ stage: "investigate", investigating: true, investError: "", investigation: null })
    try {
      const result = await investigateCommand(command)
      // The user may have cancelled while the CLI was running — don't yank
      // them back to the result stage.
      setStore((prev) =>
        prev.stage === "investigate"
          ? { investigating: false, investigation: result, stage: "result" as const }
          : {},
      )
    } catch (e) {
      setStore((prev) =>
        prev.stage === "investigate"
          ? {
              investigating: false,
              investError: e instanceof Error ? e.message : String(e),
              stage: "result" as const,
            }
          : {},
      )
    }
  }

  const applyRule = async () => {
    const rule = store.investigation?.rule
    if (!rule || rule.rejected_reason) return
    try {
      const args = ["gate", "add", rule.regex, "--kind", "allow", "--host", "%"]
      if (rule.note) args.push("--note", rule.note)
      await runAiSessions(args, 30_000)
    } catch (e) {
      setStore({
        investError: e instanceof Error ? e.message : String(e),
        stage: "result",
      })
      return
    }
    setStore("stage", "permission")
    void replyOnce()
  }

  const openDiscuss = (action: "once" | "reject") => {
    setStore({ discussAction: action, stage: "discuss" })
  }

  const sendDiscuss = async (message: string) => {
    const text = message.trim()
    if (!text) return
    if (store.discussAction === "reject") {
      void replyReject(text)
    } else {
      // Allow the command once AND steer the session with the user's message.
      void replyOnce()
      void sdk.client.session.prompt({
        sessionID: props.request.sessionID,
        directory: props.directory,
        workspace: project.workspace.current(),
        parts: [{ type: "text", text }],
      })
    }
    setStore("stage", "permission")
  }

  return (
    <Switch>
      <Match when={store.stage === "investigate"}>
        <Prompt
          title="Investigating auto-allow"
          body={
            <box paddingLeft={1} flexDirection="column" gap={1}>
              <text fg={theme.text}>{"$ " + bashCommand()}</text>
              <text fg={theme.textMuted}>
                {store.investigating ? "Asking the model to analyze this command family…" : ""}
              </text>
            </box>
          }
          options={{ cancel: "Cancel" }}
          escapeKey="cancel"
          onSelect={() => {
            setStore("stage", "permission")
          }}
        />
      </Match>
      <Match when={store.stage === "result"}>
        {(() => {
          const inv = store.investigation
          if (store.investError || !inv) {
            return (
              <Prompt
                title="Investigation failed"
                body={
                  <box paddingLeft={1}>
                    <text fg={theme.error} wrapMode="word">
                      {store.investError || "No investigation result"}
                    </text>
                  </box>
                }
                options={{ back: "Back" }}
                escapeKey="back"
                fullscreen
                onSelect={() => setStore("stage", "permission")}
              />
            )
          }

          const propose = inv.verdict === "propose" && inv.rule && !inv.rule.rejected_reason
          const verdictLabel =
            inv.verdict === "propose"
              ? "Safe to auto-allow — validated rule proposal below"
              : inv.verdict === "unsafe"
                ? "NOT safe to auto-allow"
                : "No safe regex rule available"

          return (
            <Prompt
              title="Auto-allow analysis"
              header={
                <box flexDirection="column" gap={0}>
                  <box flexDirection="row" gap={1} flexShrink={0}>
                    <text fg={propose ? theme.success : theme.warning}>{propose ? "✓" : "△"}</text>
                    <text fg={theme.text}>{verdictLabel}</text>
                  </box>
                  <box flexDirection="row" gap={1} paddingLeft={2} flexShrink={0}>
                    <text fg={theme.textMuted} flexShrink={0}>
                      {"#"}
                    </text>
                    <text fg={theme.text} wrapMode="word">
                      {"$ " + inv.command}
                    </text>
                  </box>
                </box>
              }
              body={
                <scrollbox
                  height="100%"
                  verticalScrollbarOptions={{
                    trackOptions: {
                      backgroundColor: theme.background,
                      foregroundColor: theme.borderActive,
                    },
                  }}
                >
                  <box flexDirection="column" gap={1} paddingRight={1}>
                    <box paddingLeft={1}>
                      <text fg={theme.text} wrapMode="word">
                        {inv.reasoning}
                      </text>
                    </box>
                    <Show when={inv.rule?.rejected_reason}>
                      <box paddingLeft={1} flexDirection="column" gap={0}>
                        <text fg={theme.warning}>{"Proposed rule rejected by safety checks:"}</text>
                        <text fg={theme.warning}>{"  " + inv.rule?.rejected_reason}</text>
                      </box>
                    </Show>
                    <Show when={inv.rule}>
                      <box paddingLeft={1} flexDirection="column" gap={0}>
                        <text fg={theme.textMuted}>{"Proposed gate rule"}</text>
                        <text fg={inv.rule?.rejected_reason ? theme.warning : theme.success}>
                          {"  " + inv.rule?.regex}
                        </text>
                      </box>
                    </Show>
                    <Show when={inv.matcher_suggestion}>
                      <box paddingLeft={1} flexDirection="column" gap={0}>
                        <text fg={theme.textMuted}>{"Matcher suggestion (needs a work item)"}</text>
                        <text fg={theme.text}>{"  " + inv.matcher_suggestion}</text>
                      </box>
                    </Show>
                    <box paddingLeft={1}>
                      <text fg={theme.textMuted}>{"Analyzed by " + inv.model + " via ai-sessions"}</text>
                    </box>
                  </box>
                </scrollbox>
              }
              options={
                propose
                  ? {
                      apply: "Add rule & allow",
                      onceMsg: "Allow once w/ message",
                      rejectMsg: "Reject w/ message",
                    }
                  : { onceMsg: "Allow once w/ message", rejectMsg: "Reject w/ message" }
              }
              fullscreen
              onEscape={() => setStore("stage", "permission")}
              onSelect={(option) => {
                if (option === "apply") {
                  void applyRule()
                  return
                }
                if (option === "onceMsg") {
                  openDiscuss("once")
                  return
                }
                if (option === "rejectMsg") {
                  openDiscuss("reject")
                  return
                }
                setStore("stage", "permission")
              }}
            />
          )
        })()}
      </Match>
      <Match when={store.stage === "discuss"}>
        <DiscussPrompt
          allow={store.discussAction === "once"}
          onConfirm={(message) => {
            void sendDiscuss(message)
          }}
          onCancel={() => setStore("stage", "result")}
        />
      </Match>
      <Match when={store.stage === "always"}>
        <Prompt
          title="Always allow"
          body={
            <Switch>
              <Match when={props.request.always.length === 1 && props.request.always[0] === "*"}>
                <TextBody title={"This will allow " + props.request.permission + " until OpenCode is restarted."} />
              </Match>
              <Match when={true}>
                <box paddingLeft={1} gap={1}>
                  <text fg={theme.textMuted}>This will allow the following patterns until OpenCode is restarted</text>
                  <box>
                    <For each={props.request.always}>
                      {(pattern) => (
                        <text fg={theme.text}>
                          {"- "}
                          {pattern}
                        </text>
                      )}
                    </For>
                  </box>
                </box>
              </Match>
            </Switch>
          }
          options={{ confirm: "Confirm", cancel: "Cancel" }}
          escapeKey="cancel"
          onSelect={(option) => {
            setStore("stage", "permission")
            if (option === "cancel") return
            void sdk.client.permission.reply({
              reply: "always",
              requestID: props.request.id,
              directory: props.directory,
              workspace: project.workspace.current(),
            })
          }}
        />
      </Match>
      <Match when={store.stage === "reject"}>
        <DiscussPrompt
          allow={false}
          onConfirm={(message) => {
            void replyReject(message)
            setStore("stage", "permission")
          }}
          onCancel={() => {
            setStore("stage", "permission")
          }}
        />
      </Match>
      <Match when={store.stage === "permission"}>
        {(() => {
          const info = () => {
            const permission = props.request.permission
            const data = input()

            if (permission === "edit") {
              const raw = props.request.metadata?.filepath
              const filepath = typeof raw === "string" ? raw : ""
              return {
                icon: "→",
                title: `Edit ${pathFormatter.format(filepath)}`,
                body: <EditBody request={props.request} />,
              }
            }

            if (permission === "read") {
              const raw = data.filePath
              const filePath = typeof raw === "string" ? raw : ""
              return {
                icon: "→",
                title: `Read ${pathFormatter.format(filePath)}`,
                body: (
                  <Show when={filePath}>
                    <box paddingLeft={1}>
                      <text fg={theme.textMuted}>{"Path: " + pathFormatter.format(filePath)}</text>
                    </box>
                  </Show>
                ),
              }
            }

            if (permission === "glob") {
              const pattern = typeof data.pattern === "string" ? data.pattern : ""
              return {
                icon: "✱",
                title: `Glob "${pattern}"`,
                body: (
                  <Show when={pattern}>
                    <box paddingLeft={1}>
                      <text fg={theme.textMuted}>{"Pattern: " + pattern}</text>
                    </box>
                  </Show>
                ),
              }
            }

            if (permission === "grep") {
              const pattern = typeof data.pattern === "string" ? data.pattern : ""
              return {
                icon: "✱",
                title: `Grep "${pattern}"`,
                body: (
                  <Show when={pattern}>
                    <box paddingLeft={1}>
                      <text fg={theme.textMuted}>{"Pattern: " + pattern}</text>
                    </box>
                  </Show>
                ),
              }
            }

            if (permission === "list") {
              const raw = data.path
              const dir = typeof raw === "string" ? raw : ""
              return {
                icon: "→",
                title: `List ${pathFormatter.format(dir)}`,
                body: (
                  <Show when={dir}>
                    <box paddingLeft={1}>
                      <text fg={theme.textMuted}>{"Path: " + pathFormatter.format(dir)}</text>
                    </box>
                  </Show>
                ),
              }
            }

            if (permission === "bash") {
              const command = typeof data.command === "string" ? data.command : ""
              return {
                icon: "#",
                title: "Shell command",
                body: (
                  <Show when={command}>
                    <box paddingLeft={1}>
                      <text fg={theme.text}>{"$ " + command}</text>
                    </box>
                  </Show>
                ),
              }
            }

            if (permission === "task") {
              const type = typeof data.subagent_type === "string" ? data.subagent_type : "Unknown"
              const desc = typeof data.description === "string" ? data.description : ""
              return {
                icon: "#",
                title: `${Locale.titlecase(type)} Task`,
                body: (
                  <Show when={desc}>
                    <box paddingLeft={1}>
                      <text fg={theme.text}>{"◉ " + desc}</text>
                    </box>
                  </Show>
                ),
              }
            }

            if (permission === "webfetch") {
              const url = typeof data.url === "string" ? data.url : ""
              return {
                icon: "%",
                title: `WebFetch ${url}`,
                body: (
                  <Show when={url}>
                    <box paddingLeft={1}>
                      <text fg={theme.textMuted}>{"URL: " + url}</text>
                    </box>
                  </Show>
                ),
              }
            }

            if (permission === "websearch") {
              const query = typeof data.query === "string" ? data.query : ""
              return {
                icon: "◈",
                title: `${webSearchProviderLabel(data.provider)} "${query}"`,
                body: (
                  <Show when={query}>
                    <box paddingLeft={1}>
                      <text fg={theme.textMuted}>{"Query: " + query}</text>
                    </box>
                  </Show>
                ),
              }
            }

            if (permission === "external_directory") {
              const meta = props.request.metadata ?? {}
              const parent = typeof meta["parentDir"] === "string" ? meta["parentDir"] : undefined
              const filepath = typeof meta["filepath"] === "string" ? meta["filepath"] : undefined
              const pattern = props.request.patterns?.[0]
              const derived =
                typeof pattern === "string" ? (pattern.includes("*") ? dirname(pattern) : pattern) : undefined

              const raw = parent ?? filepath ?? derived
              const dir = pathFormatter.format(raw)
              const patterns = (props.request.patterns ?? []).filter((p): p is string => typeof p === "string")

              return {
                icon: "←",
                title: `Access external directory ${dir}`,
                body: (
                  <Show when={patterns.length > 0}>
                    <box paddingLeft={1} gap={1}>
                      <text fg={theme.textMuted}>Patterns</text>
                      <box>
                        <For each={patterns}>{(p) => <text fg={theme.text}>{"- " + p}</text>}</For>
                      </box>
                    </box>
                  </Show>
                ),
              }
            }

            if (permission === "doom_loop") {
              return {
                icon: "⟳",
                title: "Continue after repeated failures",
                body: (
                  <box paddingLeft={1}>
                    <text fg={theme.textMuted}>This keeps the session running despite repeated failures.</text>
                  </box>
                ),
              }
            }

            return {
              icon: "⚙",
              title: `Call tool ${permission}`,
              body: (
                <box paddingLeft={1}>
                  <text fg={theme.textMuted}>{"Tool: " + permission}</text>
                </box>
              ),
            }
          }

          const current = info()

          const header = () => (
            <box flexDirection="column" gap={0}>
              <box flexDirection="row" gap={1} flexShrink={0}>
                <text fg={theme.warning}>{"△"}</text>
                <text fg={theme.text}>Permission required</text>
              </box>
              <box flexDirection="row" gap={1} paddingLeft={2} flexShrink={0}>
                <text fg={theme.textMuted} flexShrink={0}>
                  {current.icon}
                </text>
                <text fg={theme.text}>{current.title}</text>
              </box>
            </box>
          )

          const body = (
            <Prompt
              title="Permission required"
              header={header()}
              body={current.body}
              options={
                props.request.permission === "bash"
                  ? { once: "Allow once", investigate: "Investigate auto-allow", reject: "Reject" }
                  : { once: "Allow once", always: "Allow always", reject: "Reject" }
              }
              escapeKey="reject"
              fullscreen
              onSelect={(option) => {
                if (option === "always") {
                  setStore("stage", "always")
                  return
                }
                if (option === "investigate") {
                  void startInvestigate()
                  return
                }
                if (option === "reject") {
                  if (session()?.parentID) {
                    setStore("stage", "reject")
                    return
                  }
                  void sdk.client.permission.reply({
                    reply: "reject",
                    requestID: props.request.id,
                    directory: props.directory,
                    workspace: project.workspace.current(),
                  })
                  return
                }
                void sdk.client.permission.reply({
                  reply: "once",
                  requestID: props.request.id,
                  directory: props.directory,
                  workspace: project.workspace.current(),
                })
              }}
            />
          )

          return body
        })()}
      </Match>
    </Switch>
  )
}

function DiscussPrompt(props: { allow: boolean; onConfirm: (message: string) => void; onCancel: () => void }) {
  let input: TextareaRenderable
  const { theme } = useTheme()
  const tuiConfig = useTuiConfig()
  const dimensions = useTerminalDimensions()
  const narrow = createMemo(() => dimensions().width < 80)
  useBindings(() => ({
    mode: OPENCODE_BASE_MODE,
    commands: [
      {
        name: "app.exit",
        title: "Cancel permission message",
        category: "Permission",
        run() {
          props.onCancel()
        },
      },
    ],
    bindings: [
      { key: "escape", desc: "Cancel permission message", group: "Permission", cmd: () => props.onCancel() },
      ...tuiConfig.keybinds.get("app.exit"),
      {
        key: "return",
        desc: props.allow ? "Allow once with message" : "Reject with message",
        group: "Permission",
        cmd: () => props.onConfirm(input.plainText),
      },
    ],
  }))

  return (
    <box
      backgroundColor={theme.backgroundPanel}
      border={["left"]}
      borderColor={props.allow ? theme.success : theme.error}
      customBorderChars={SplitBorder.customBorderChars}
    >
      <box gap={1} paddingLeft={1} paddingRight={3} paddingTop={1} paddingBottom={1}>
        <box flexDirection="row" gap={1} paddingLeft={1}>
          <text fg={props.allow ? theme.success : theme.error}>{props.allow ? "✓" : "△"}</text>
          <text fg={theme.text}>{props.allow ? "Allow once with message" : "Reject with message"}</text>
        </box>
        <box paddingLeft={1}>
          <text fg={theme.textMuted}>
            {props.allow
              ? "The command runs once; your message is sent to the agent"
              : "Tell OpenCode what to do differently"}
          </text>
        </box>
      </box>
      <box
        flexDirection={narrow() ? "column" : "row"}
        flexShrink={0}
        paddingTop={1}
        paddingLeft={2}
        paddingRight={3}
        paddingBottom={1}
        backgroundColor={theme.backgroundElement}
        justifyContent={narrow() ? "flex-start" : "space-between"}
        alignItems={narrow() ? "flex-start" : "center"}
        gap={1}
      >
        <textarea
          ref={(val: TextareaRenderable) => {
            input = val
            val.traits = { status: props.allow ? "ALLOW" : "REJECT" }
          }}
          focused
          textColor={theme.text}
          focusedTextColor={theme.text}
          cursorColor={theme.primary}
          cursorStyle={tuiConfig.cursor}
        />
        <box flexDirection="row" gap={2} flexShrink={0}>
          <text fg={theme.text}>
            enter <span style={{ fg: theme.textMuted }}>confirm</span>
          </text>
          <text fg={theme.text}>
            esc <span style={{ fg: theme.textMuted }}>back</span>
          </text>
        </box>
      </box>
    </box>
  )
}

function Prompt<const T extends Record<string, string>>(props: {
  title: string
  header?: JSX.Element
  body: JSX.Element
  options: T
  escapeKey?: keyof T
  fullscreen?: boolean
  onEscape?: () => void
  onSelect: (option: keyof T) => void
}) {
  const { theme } = useTheme()
  const tuiConfig = useTuiConfig()
  const dimensions = useTerminalDimensions()
  const keys = Object.keys(props.options) as (keyof T)[]
  const [store, setStore] = createStore({
    selected: keys[0],
    expanded: false,
  })
  const narrow = createMemo(() => dimensions().width < 80)
  const fullscreenHint = useCommandShortcut("permission.prompt.fullscreen")

  useBindings(() => ({
    mode: OPENCODE_BASE_MODE,
    commands: [
      {
        name: "app.exit",
        title: props.onEscape ? "Back" : "Reject permission",
        category: "Permission",
        run() {
          if (props.onEscape) {
            props.onEscape()
            return
          }
          if (!props.escapeKey) return
          props.onSelect(props.escapeKey)
        },
      },
      {
        name: "permission.prompt.fullscreen",
        title: "Toggle permission fullscreen",
        category: "Permission",
        run() {
          if (!props.fullscreen) return
          setStore("expanded", (v) => !v)
        },
      },
    ],
    bindings: [
      {
        key: "left",
        desc: "Previous permission option",
        group: "Permission",
        cmd: () => {
          const idx = keys.indexOf(store.selected)
          const next = keys[(idx - 1 + keys.length) % keys.length]
          setStore("selected", next)
        },
      },
      {
        key: "h",
        desc: "Previous permission option",
        group: "Permission",
        cmd: () => {
          const idx = keys.indexOf(store.selected)
          const next = keys[(idx - 1 + keys.length) % keys.length]
          setStore("selected", next)
        },
      },
      {
        key: "right",
        desc: "Next permission option",
        group: "Permission",
        cmd: () => {
          const idx = keys.indexOf(store.selected)
          const next = keys[(idx + 1) % keys.length]
          setStore("selected", next)
        },
      },
      {
        key: "l",
        desc: "Next permission option",
        group: "Permission",
        cmd: () => {
          const idx = keys.indexOf(store.selected)
          const next = keys[(idx + 1) % keys.length]
          setStore("selected", next)
        },
      },
      {
        key: "return",
        desc: "Select permission option",
        group: "Permission",
        cmd: () => props.onSelect(store.selected),
      },
      ...(props.onEscape
        ? [
            {
              key: "escape",
              desc: "Back",
              group: "Permission",
              cmd: () => props.onEscape!(),
            },
          ]
        : props.escapeKey
          ? [
              {
                key: "escape",
                desc: "Reject permission",
                group: "Permission",
                cmd: () => props.onSelect(props.escapeKey!),
              },
            ]
          : []),
      ...(props.escapeKey ? tuiConfig.keybinds.get("app.exit") : []),
      ...(props.fullscreen ? tuiConfig.keybinds.get("permission.prompt.fullscreen") : []),
    ],
  }))

  const hint = createMemo(() => (store.expanded ? "minimize" : "fullscreen"))
  useRenderer()

  const content = () => (
    <box
      backgroundColor={theme.backgroundPanel}
      border={["left"]}
      borderColor={theme.warning}
      customBorderChars={SplitBorder.customBorderChars}
      {...(store.expanded
        ? { top: dimensions().height * -1 + 1, bottom: 1, left: 2, right: 2, position: "absolute" }
        : {
            top: 0,
            maxHeight: 15,
            bottom: 0,
            left: 0,
            right: 0,
            position: "relative",
          })}
    >
      <box gap={1} paddingLeft={1} paddingRight={3} paddingTop={1} paddingBottom={1} flexGrow={1}>
        <Show
          when={props.header}
          fallback={
            <box flexDirection="row" gap={1} paddingLeft={1} flexShrink={0}>
              <text fg={theme.warning}>{"△"}</text>
              <text fg={theme.text}>{props.title}</text>
            </box>
          }
        >
          <box paddingLeft={1} flexShrink={0}>
            {props.header}
          </box>
        </Show>
        {props.body}
      </box>
      <box
        flexDirection={narrow() ? "column" : "row"}
        flexShrink={0}
        gap={1}
        paddingTop={1}
        paddingLeft={2}
        paddingRight={3}
        paddingBottom={1}
        backgroundColor={theme.backgroundElement}
        justifyContent={narrow() ? "flex-start" : "space-between"}
        alignItems={narrow() ? "flex-start" : "center"}
      >
        <box flexDirection="row" gap={1} flexShrink={0}>
          <For each={keys}>
            {(option) => (
              <box
                paddingLeft={1}
                paddingRight={1}
                backgroundColor={option === store.selected ? theme.warning : theme.backgroundMenu}
                onMouseOver={() => setStore("selected", option)}
                onMouseUp={() => {
                  setStore("selected", option)
                  props.onSelect(option)
                }}
              >
                <text fg={option === store.selected ? selectedForeground(theme, theme.warning) : theme.textMuted}>
                  {props.options[option]}
                </text>
              </box>
            )}
          </For>
        </box>
        <box flexDirection="row" gap={2} flexShrink={0}>
          <Show when={props.fullscreen}>
            <text fg={theme.text}>
              {fullscreenHint()} <span style={{ fg: theme.textMuted }}>{hint()}</span>
            </text>
          </Show>
          <text fg={theme.text}>
            {"⇆"} <span style={{ fg: theme.textMuted }}>select</span>
          </text>
          <text fg={theme.text}>
            enter <span style={{ fg: theme.textMuted }}>confirm</span>
          </text>
        </box>
      </box>
    </box>
  )

  return (
    <Show when={!store.expanded} fallback={<Portal>{content()}</Portal>}>
      {content()}
    </Show>
  )
}
