import { Effect } from "effect"
import type { DatabaseMigration } from "./migration"

export default {
  id: "20260826000000_web_push",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`web_push_vapid\` (
          \`id\` integer PRIMARY KEY CHECK (\`id\` = 1),
          \`public_key\` text NOT NULL,
          \`private_key\` text NOT NULL,
          \`time_created\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`web_push_subscription\` (
          \`id\` text PRIMARY KEY,
          \`endpoint\` text NOT NULL,
          \`p256dh\` text NOT NULL,
          \`auth\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`CREATE INDEX \`web_push_subscription_time_created_idx\` ON \`web_push_subscription\` (\`time_created\`);`)
    })
  },
} satisfies Omit<DatabaseMigration.Migration, "id">