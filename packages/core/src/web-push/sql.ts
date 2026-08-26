import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core"
import { Timestamps } from "../database/schema.sql"
import type { WebPush } from "@opencode-ai/schema/web-push"

export const WebPushVAPIDTable = sqliteTable("web_push_vapid", {
  id: integer().primaryKey(),
  public_key: text().$type<WebPush.VAPIDPublicKey>().notNull(),
  private_key: text().$type<WebPush.VAPIDPrivateKey>().notNull(),
  time_created: integer().notNull(),
})

export const WebPushSubscriptionTable = sqliteTable(
  "web_push_subscription",
  {
    id: text().$type<WebPush.PushSubscription["id"]>().primaryKey(),
    endpoint: text().notNull(),
    p256dh: text().notNull(),
    auth: text().notNull(),
    time_created: integer().notNull(),
    time_updated: integer().notNull(),
  },
  (table) => [index("web_push_subscription_time_created_idx").on(table.time_created)],
)