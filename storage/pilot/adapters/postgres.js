import { assertAtomicRecordStore, checkKey, copy, RecordConflictError, RecordExistsError } from '../contract.js';
// A bounded single-table JSONB store; all query inputs are parameterized.
// The benchmark needs a warm pg.Pool, not a new SQL connection per request.
export class PostgresAtomicRecords {
  constructor({ pool, table = 'native_storage_benchmark' }) {
    if (!pool?.connect || !/^[a-z_][a-z_0-9]*$/.test(table)) throw new TypeError('pg pool/table required');
    this.pool = pool;
    this.table = table;
    assertAtomicRecordStore(this);
  }
  async initialize() {
    await this.pool.query(`CREATE TABLE IF NOT EXISTS ${this.table} (id varchar(120) PRIMARY KEY, state jsonb NOT NULL)`);
  }
  async get(key) {
    const { rows } = await this.pool.query(`SELECT state FROM ${this.table} WHERE id = $1`, [checkKey(key)]);
    return rows.length ? copy(rows[0].state) : null;
  }
  async create(key, value) {
    const r = await this.pool.query(`INSERT INTO ${this.table} (id, state) VALUES ($1,$2::jsonb) ON CONFLICT DO NOTHING`,
      [checkKey(key), JSON.stringify(value)]);
    if (r.rowCount !== 1) throw new RecordExistsError();
  }
  async put(key, value) {
    await this.pool.query(`INSERT INTO ${this.table} (id,state) VALUES ($1,$2::jsonb) ON CONFLICT(id) DO UPDATE SET state=EXCLUDED.state`,
      [checkKey(key), JSON.stringify(value)]);
  }
  async mutate(key, change) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(`SELECT state FROM ${this.table} WHERE id=$1 FOR UPDATE`, [checkKey(key)]);
      const next = change(rows.length ? copy(rows[0].state) : null);
      if (next === undefined) throw new RecordConflictError();
      if (rows.length) await client.query(`UPDATE ${this.table} SET state=$2::jsonb WHERE id=$1`,
        [key, JSON.stringify(next)]);
      else await client.query(`INSERT INTO ${this.table} (id,state) VALUES ($1,$2::jsonb)`,
        [key, JSON.stringify(next)]);
      await client.query('COMMIT');
      return copy(next);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      if (error?.code === '23505') throw new RecordExistsError();
      throw error;
    } finally { client.release(); }
  }
  async delete(key) { await this.pool.query(`DELETE FROM ${this.table} WHERE id=$1`, [checkKey(key)]); }
  async close() { await this.pool.end(); }
}
