import LevelUpCtor, { LevelUp } from 'levelup';
import LevelDown from 'leveldown';
import { Mutex } from 'async-mutex';

export class ValueError extends Error {
  public readonly name = 'ValueError';
}

export type Primitive = string | number | boolean | Date | null;
export interface SerializableArray extends Array<SerializableArray | SerializableObject | Primitive | undefined> {}
export interface SerializableObject { [key: string]: SerializableArray | SerializableObject | Primitive | undefined; }
export type Serializable = Primitive | SerializableArray | SerializableObject;

function checkValue(value: Serializable) {
  if (typeof value === 'undefined') {
    throw new ValueError('Value must be not be undefined');
  }
}

export class DB {
  protected readonly writeLock = new Mutex();
  protected readonly db: LevelUp;
  constructor(protected readonly dbPath: string) {
    this.db = new LevelUpCtor(new LevelDown(dbPath));
  }

  /**
   * Gets a single document.
   * @return - value or undefined if key doesn’t exist.
   */
  public async get(key: string): Promise<Serializable | undefined> {
    try {
      const val = await this.db.get(key);
      return JSON.parse(val.toString());
    } catch (err) {
      if (err.name === 'NotFoundError') {
        return undefined;
      }
      throw err;
    }
  }

  /**
   * Creates a document for given key.
   * @param value - Cannot be undefined, must be an object
   * @return - true if document was created, false if key already exists.
   */
  public async create(key: string, value: Serializable): Promise<boolean> {
    checkValue(value);
    const serialized = JSON.stringify(value);
    return await this.writeLock.runExclusive(async () => {
      const prev =  await this.get(key);
      if (prev !== undefined) {
        return false;
      }
      await this.db.put(key, serialized);
      return true;
    });
  }

  /**
   * Removes a single document.
   * @return - true if document was deleted, false if key doesn’t exist.
   */
  public async remove(key: string): Promise<boolean> {
    return await this.writeLock.runExclusive(async () => {
      const prev = await this.get(key);
      if (prev === undefined) {
        return false;
      }
      await this.db.del(key);
      return true;
    });
  }

  /**
   * Updates a single document.
   * @param updater - Function that gets the previous value and returns the next value
   *                  to update the DB with, updater cannot return undefined.
   * @param initializer - `updater` will get this value if no document exists for `key`.
   * @return - The new value returned from updater
   */
  public async update<T extends Serializable, R extends Serializable>(
    key: string, updater: (state?: T) => R, initializer?: T
  ): Promise<R> {
    return await this.writeLock.runExclusive(async () => {
      const prev = await this.get(key) || initializer;
      const next = updater(prev as T);
      checkValue(next);
      await this.db.put(key, JSON.stringify(next));
      return next;
    });
  }
}
