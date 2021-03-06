import { pair, path, pick, sortWith, ascend, descend } from 'ramda';
import { compare } from 'fast-json-patch';
import LevelUpCtor, { LevelUp } from 'levelup';
import LevelDown from 'leveldown';
import { Mutex } from 'async-mutex';
import { Context as KoaContext } from 'koa';
import nanoid from 'nanoid';
import { DBHandler, Context, ServerOnlyContext } from '@reshuffle/interfaces-koa-server';
import {
  UpdateOptions,
  Version,
  StoredDocument,
  Tombstone,
  Patch,
  PollOptions,
  Serializable,
  VersionedMaybeObject,
  Document,
  Query,
  Order,
  Filter,
} from '@reshuffle/interfaces-koa-server/interfaces';
import { ValueError } from './errors';
import { withTimeout, deferred, hrnano } from './utils';
import { EventEmitter } from 'events';

// BUG: Lost by typescript-json-schema in Concord, reintroduce it here.
export type KeyedPatches = Array<[string, Patch[]]>;

const NUM_PATCHES_TO_KEEP = 20;
const DEFAULT_READ_BLOCK_TIME_MS = 50000;

export class WrappedError extends Error {
  constructor(msg: string, public readonly err: Error, public readonly debugId: string) {
    super(msg);
    this.stack += `\ncaused by:\n${err.stack}`;
  }
}

export function incrVersion({ major, minor }: Version, amount: number = 1): Version {
  return { major, minor: minor + amount };
}

export function decrVersion(version: Version, amount: number = 1): Version {
  return incrVersion(version, -amount);
}

export function isGreaterVersion(a: Version, b: Version): boolean {
  return a.major > b.major || a.major === b.major && a.minor > b.minor;
}

export type KeyedVersions = Array<[string, Version]>;

// bigint not currently allowed.
const allowedTypes = new Set(['object', 'boolean', 'number', 'string']);

function checkValue(value: Serializable) {
  if (!allowedTypes.has(typeof value)) {
    throw new TypeError(`Non-JSONable value of type ${typeof value} at top level`);
  }
}

function isLiveValue(maybe: StoredDocument | Tombstone | undefined): maybe is StoredDocument {
  return maybe !== undefined && (maybe as any).value !== undefined;
}

function versionsMatch(prev: StoredDocument | Tombstone | undefined, version: Version) {
  if (!prev) {
    return version.major === 0 && version.minor === 0;
  }
  return prev.version.major === version.major && prev.version.minor === version.minor;
}

function valueOrUndefined(maybeHasValue?: any) {
  return maybeHasValue === undefined ? undefined : maybeHasValue.value;
}

export class Handler implements DBHandler {
  protected emitter = new EventEmitter();
  protected readonly writeLock = new Mutex();
  protected readonly db: LevelUp;

  constructor(protected readonly dbPath: string, initialData?: any, errorCallback?: (err: Error | undefined) => any) {
    this.db = new LevelUpCtor(new LevelDown(dbPath), errorCallback);
    if (initialData) {
      for (const item of initialData.items) {
        // TODO: deduplicate local appId
        this.create(
          {
            debugId: 'template initial data',
            appId: 'local-app',
            appEnv: 'local',
            collection: 'default',
            auth: {},
          },
          item.key,
          item.data
        ).catch(() => {
          // Logging during startup will usually get cleared by create-react-app
          // screen clear, but the log will still be saved in the log directory
          /* eslint-disable-next-line no-console */
          console.error('Failed create initial data', item);
        });
      }
    }
  }

  public async extractContext(_ctx: KoaContext): Promise<ServerOnlyContext> {
    return { debugId: nanoid() };
  }

  protected async put(
    key: string, prev: StoredDocument | Tombstone | undefined, value: any, options?: UpdateOptions
  ): Promise<void> {
    const prevValue = valueOrUndefined(prev);
    const version = prev === undefined || (prev as any).value === undefined ?
      { major: hrnano(), minor: 1 } : incrVersion(prev.version);
    const patches = prev ? prev.patches : [];
    const ops = compare({ root: prevValue }, { root: value });
    if (ops.length > 0) {
      const patch = { version, ops, ...options };
      await this.db.put(key, JSON.stringify({
        version,
        value,
        patches: patches.slice(-NUM_PATCHES_TO_KEEP).concat(patch),
        updatedAt: hrnano(),
      }));
      // Trigger return from outstanding `poll`.
      this.emitter.emit('patch', key, patch);
    }
  }

  /**
   * Gets a single document.
   * @return - value or undefined if key doesn’t exist.
   */
  public async get(ctx: Context, key: string): Promise<Serializable | undefined> {
    const versioned = await this.getWithMeta(ctx, key);
    if (versioned === undefined) {
      return undefined;
    }
    return (versioned as any).value;
  }

  /**
   * Gets a single document with its version.
   * @return - { version, value, patches, updatedAt } or undefined if key doesn’t exist.
   */
  public async getWithMeta(
    { debugId }: Context, key: string
  ): Promise<StoredDocument | Tombstone | undefined> {
    try {
      const val = await this.db.get(key);
      return JSON.parse(val.toString());
    } catch (err) {
      if (err.notFound) return undefined;
      throw new WrappedError(`[${debugId}] ${err.message}`, err, debugId);
    }
  }

  /**
   * Gets just a single document with its version.  This is smaller than getWithMeta.
   * @return - { version, value } or undefined if key doesn’t exist.
   */
  public async getWithVersion(ctx: Context, key: string): Promise<VersionedMaybeObject> {
    const withMeta = await this.getWithMeta(ctx, key);
    if (!withMeta) {
      return { version: { major: 0, minor: 0 } };
    }
    return pick(['value', 'version'], withMeta);
  }

  public async startPolling(ctx: Context, key: string): Promise<VersionedMaybeObject> {
    return this.getWithVersion(ctx, key);
  }

  /**
   * Creates a document for given key.
   * @param value - Cannot be undefined, must be an object
   * @return - true if document was created, false if key already exists.
   */
  public async create(ctx: Context, key: string, value: Serializable): Promise<boolean> {
    checkValue(value);
    return this.writeLock.runExclusive(async () => {
      const prev = await this.getWithMeta(ctx, key);
      if (isLiveValue(prev)) {
        return false;
      }
      await this.put(key, prev, value);
      return true;
    });
  }

  /**
   * Removes a single document.
   * @return - true if document was deleted, false if key doesn’t exist.
   */
  public async remove(ctx: Context, key: string): Promise<boolean> {
    return this.writeLock.runExclusive(async () => {
      const prev = await this.getWithMeta(ctx, key);
      if (valueOrUndefined(prev) === undefined) {
        return false;
      }
      // TODO: Schedule periodic DB vacuum and delete old tombstones
      await this.put(key, prev, undefined);
      return true;
    });
  }

  public async setIfVersion(
    ctx: Context, key: string, version: Version, value?: Serializable, options?: UpdateOptions,
  ): Promise<boolean> {
    if (value !== undefined) checkValue(value);
    return this.writeLock.runExclusive(async () => {
      const prev = await this.getWithMeta(ctx, key);
      if (!versionsMatch(prev, version)) return false;
      await this.put(key, prev, value, options);
      return true;
    });
  }

  /**
   * Polls on updates to specified keys since specified versions.
   * @see KeyedVersions
   * @see KeyedPatches
   */
  public async poll(
    ctx: Context,
    keysToVersions: KeyedVersions,
    opts: PollOptions = {},
  ): Promise<KeyedPatches> {
    const keysToVersionsMap = new Map(keysToVersions);
    const { promise, resolve } = deferred<KeyedPatches>();
    // Make sure we don't miss any live updates in case the initial scan (below) comes back empty.
    const patchHandler = (key: string, patch: Patch) => {
      const subscribedVersion = keysToVersionsMap.get(key);
      if (subscribedVersion !== undefined && isGreaterVersion(patch.version, subscribedVersion)) {
        resolve([[key, [patch]]]);
      }
    };
    this.emitter.on('patch', patchHandler);
    try {
      // Scan the DB for matching patches
      const keyedPatchesOrUndef = await Promise.all(keysToVersions.map(async ([key, version]) => {
        const doc = await this.getWithMeta(ctx, key);
        if (doc === undefined) {
          return undefined;
        }
        const patches = doc.patches.filter((patch) => isGreaterVersion(patch.version, version));
        if (patches.length === 0) {
          return undefined;
        }
        return pair(key, patches);
      }));
      const keyedPatches = keyedPatchesOrUndef.filter(
        (patch: [string, Patch[]] | undefined): patch is [string, Patch[]] => patch !== undefined);
      if (keyedPatches.length > 0) {
        return keyedPatches;
      }
      try {
        return await withTimeout(promise, opts.readBlockTimeMs || DEFAULT_READ_BLOCK_TIME_MS);
      } catch (err) {
        if (err.name === 'TimeoutError') {
          return [];
        }
        throw err;
      }
    } finally {
      this.emitter.off('patch', patchHandler);
    }
  }

  /**
   * Find documents matching query.
   * @param query - a query constructed with Q methods.
   * @return - an array of documents
   */
  public async find(_ctx: Context, { filter, limit, skip, orderBy }: Query): Promise<Document[]> {
    const results: Document[] = [];
    await new Promise((resolve, reject) => {
      const it = this.db.iterator({
        keyAsBuffer: false,
        valueAsBuffer: false,
      });
      const next = (err: any, key: string, rawValue: string) => {
        if (err) {
          return reject(err);
        }
        if (!key) {
          // Iteration complete
          return it.end(resolve);
        }
        const { value } = JSON.parse(rawValue);
        if (value !== undefined /* Not a tombstone */ && wrappedMatch({ key, value }, filter)) {
          results.push({ key, value });
        }
        return it.next(next);
      };
      it.next(next);
    });
    const sortedResults = orderBy ? sortWith(orderBy.map(buildComparator), results) : results;
    return sortedResults.slice(skip, limit === undefined ? undefined : (skip || 0) + limit);
  }
}

export function buildComparator({ path: p, direction }: Order) {
  return direction === 'ASC' ? ascend(path(p)) : descend(path(p));
}

export function wrappedMatch(doc: Document, filter: Filter): boolean {
  const isMatch = match(doc, filter);
  if (isMatch === undefined) {
    throw new ValueError(`Got an unsupported filter operator: ${filter.operator}`);
  }
  return isMatch;
}

function match(doc: Document, filter: Filter): boolean {
  switch (filter.operator) {
  case 'and':
    return filter.filters.every((f) => wrappedMatch(doc, f));
  case 'or':
    return filter.filters.some((f) => wrappedMatch(doc, f));
  case 'not':
    return !wrappedMatch(doc, filter.filter);
  }

  const value = path(filter.path, doc);

  switch (filter.operator) {
  case 'eq':
    return value === filter.value;
  case 'ne':
    return value !== filter.value;
  case 'gt':
    return typeof value === typeof filter.value && value as any > filter.value;
  case 'gte':
    return typeof value === typeof filter.value && value as any >= filter.value;
  case 'lt':
    return typeof value === typeof filter.value && value as any < filter.value;
  case 'lte':
    return typeof value === typeof filter.value && value as any <= filter.value;
  case 'exists':
    return value !== undefined;
  case 'isNull':
    return value === null;
  case 'matches': {
    if (typeof value !== 'string') {
      return false;
    }
    const regexp = new RegExp(filter.pattern, filter.caseInsensitive ? 'i' : undefined);
    return regexp.test(value);
  }
  case 'startsWith':
    if (typeof value !== 'string') {
      return false;
    }
    return value.startsWith(filter.value);
  // We don't add a default case here to let typescript catch when new operators are added and not implemented here.
  // (see wrappedMatch)
  }
}

export const testing = { match };
