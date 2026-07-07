import { MongoClient, Collection, Db } from "mongodb";
import { config, hasMongo } from "./config.js";
import type { Grievance } from "./schemas.js";

// Statuses that are still eligible to breach their SLA (open / mid-escalation).
const BREACHABLE = new Set<Grievance["status"]>(["open", "follow_up_sent"]);

/**
 * Repository abstraction so the app runs with MongoDB Atlas OR a zero-config
 * in-memory store. The rest of the codebase only sees `grievances`.
 */
export interface GrievanceRepo {
  insert(g: Grievance): Promise<Grievance>;
  get(id: string): Promise<Grievance | null>;
  update(id: string, patch: Partial<Grievance>): Promise<Grievance | null>;
  list(filter?: { user_id?: string }): Promise<Grievance[]>;
  /** open/escalating grievances whose sla_deadline has passed. */
  findBreached(now: Date): Promise<Grievance[]>;
  backend: "mongodb" | "memory";
}

class MemoryRepo implements GrievanceRepo {
  backend = "memory" as const;
  private store = new Map<string, Grievance>();
  async insert(g: Grievance) { this.store.set(g._id, g); return g; }
  async get(id: string) { return this.store.get(id) ?? null; }
  async update(id: string, patch: Partial<Grievance>) {
    const cur = this.store.get(id);
    if (!cur) return null;
    const next = { ...cur, ...patch };
    this.store.set(id, next);
    return next;
  }
  async list(filter?: { user_id?: string }) {
    let all = [...this.store.values()];
    if (filter?.user_id) all = all.filter((g) => g.user_id === filter.user_id);
    return all.sort((a, b) => b.created_at.localeCompare(a.created_at));
  }
  async findBreached(now: Date) {
    return [...this.store.values()].filter(
      (g) => BREACHABLE.has(g.status) && new Date(g.sla_deadline) <= now,
    );
  }
}

class MongoRepo implements GrievanceRepo {
  backend = "mongodb" as const;
  constructor(private col: Collection<Grievance>) {}
  async insert(g: Grievance) { await this.col.insertOne(g as any); return g; }
  async get(id: string) { return (await this.col.findOne({ _id: id as any })) as Grievance | null; }
  async update(id: string, patch: Partial<Grievance>) {
    const r = await this.col.findOneAndUpdate(
      { _id: id as any },
      { $set: patch },
      { returnDocument: "after" },
    );
    return (r as Grievance) ?? null;
  }
  async list(filter?: { user_id?: string }) {
    const q = filter?.user_id ? { user_id: filter.user_id } : {};
    return (await this.col.find(q).sort({ created_at: -1 }).toArray()) as Grievance[];
  }
  async findBreached(now: Date) {
    return (await this.col
      .find({ status: { $in: ["open", "follow_up_sent"] }, sla_deadline: { $lte: now.toISOString() } })
      .toArray()) as Grievance[];
  }
}

let repo: GrievanceRepo | null = null;
let client: MongoClient | null = null;
let mongoDb: Db | null = null;

/** Shared Mongo Db handle (null in in-memory mode) for other stores to reuse. */
export function mongoDbHandle(): Db | null {
  return mongoDb;
}

export async function initDb(): Promise<GrievanceRepo> {
  if (repo) return repo;
  if (hasMongo()) {
    try {
      client = new MongoClient(config.mongoUri, { serverSelectionTimeoutMS: 8000 });
      await client.connect();
      await client.db(config.mongoDb).command({ ping: 1 });
      mongoDb = client.db(config.mongoDb);
      const col = mongoDb.collection<Grievance>("grievances");
      await col.createIndex({ user_id: 1, created_at: -1 });
      await col.createIndex({ status: 1, sla_deadline: 1 });
      repo = new MongoRepo(col);
      console.log(`[db] connected to MongoDB (${config.mongoDb})`);
      return repo;
    } catch (e: any) {
      console.warn(`[db] MongoDB connection failed (${e?.message ?? e}) — falling back to in-memory store`);
      await client?.close().catch(() => {});
      client = null;
      mongoDb = null;
    }
  }
  repo = new MemoryRepo();
  console.log("[db] using in-memory store (data resets on restart)");
  return repo;
}

export function grievances(): GrievanceRepo {
  if (!repo) throw new Error("DB not initialized — call initDb() first");
  return repo;
}

export async function closeDb() {
  await client?.close();
}
