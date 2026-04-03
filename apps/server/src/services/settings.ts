import { eq } from 'drizzle-orm';
import { schema, type HubDatabase } from '../db/index.js';

export class SettingsService {
  constructor(private db: HubDatabase) {}

  async get<T = unknown>(key: string): Promise<T | null> {
    const rows = await this.db.select().from(schema.settings).where(eq(schema.settings.key, key));
    if (!rows[0]) return null;
    return JSON.parse(rows[0].valueJson) as T;
  }

  async set(key: string, value: unknown): Promise<void> {
    const json = JSON.stringify(value);
    const existing = await this.db.select().from(schema.settings).where(eq(schema.settings.key, key));

    if (existing[0]) {
      await this.db.update(schema.settings).set({ valueJson: json }).where(eq(schema.settings.key, key));
    } else {
      await this.db.insert(schema.settings).values({ key, valueJson: json });
    }
  }

  async getAll(): Promise<Record<string, unknown>> {
    const rows = await this.db.select().from(schema.settings);
    const result: Record<string, unknown> = {};
    for (const row of rows) {
      result[row.key] = JSON.parse(row.valueJson);
    }
    return result;
  }

  async patchMultiple(updates: Record<string, unknown>): Promise<void> {
    for (const [key, value] of Object.entries(updates)) {
      await this.set(key, value);
    }
  }
}
