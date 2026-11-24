import { Database } from 'bun:sqlite';
import { HTTPError } from './errors.js';
import { testId } from './test-id.js';

const effective = `COALESCE(manual_result, CASE WHEN state='completed' THEN json_extract(automatic,'$.result') WHEN state IN ('queued','running') THEN state ELSE 'error' END)`;
const summaryColumns = `id,model,name,test_id AS testId,json_extract(fingerprint,'$.analysis.prediction_name') AS prediction,json_extract(fingerprint,'$.analysis.prediction') AS predictionId,json_extract(fingerprint,'$.analysis.probability') AS probability,json_extract(fingerprint,'$.analysis.decision') AS decision,COALESCE(json_extract(fingerprint,'$.analysis.used_outputs'),(SELECT COUNT(*) FROM json_each(json_extract(fingerprint,'$.samples')) WHERE json_extract(value,'$.state') IN ('complete','truncated'))) AS usedOutputs,json_extract(fingerprint,'$.bank.id') AS bankId,json_extract(fingerprint,'$.bank.builtAt') AS bankBuiltAt,json_extract(fingerprint,'$.sdk') AS sdk,call_error AS callError,started_at AS startedAt,finished_at AS finishedAt,duration,state,source,${effective} AS result,manual_result IS NOT NULL AS corrected`;
const fingerprintHistory = `WITH ordered AS (
  SELECT ${summaryColumns}, ROW_NUMBER() OVER (ORDER BY started_at,rowid) AS seq,
    (SELECT COUNT(*) FROM json_each(json_extract(fingerprint,'$.samples')) WHERE json_extract(value,'$.state') IN ('complete','truncated','failed','cancelled')) AS samplesFinished,
    (SELECT CAST(key AS INTEGER)+1 FROM json_each(json_extract(fingerprint,'$.samples')) WHERE json_extract(value,'$.state')='waiting' LIMIT 1) AS samplingIndex
  FROM records WHERE model=? AND test_id='fingerprint'
), linked AS (
  SELECT *,
    MAX(CASE WHEN bankId IS NOT NULL THEN seq END) OVER (ORDER BY seq ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS bankSeq,
    MAX(CASE WHEN state='completed' AND decision='scored' THEN seq END) OVER (ORDER BY seq ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS scoredSeq
  FROM ordered
), annotated AS (
  SELECT current.*, previous.prediction AS previousPrediction,
    CASE WHEN current.sdk IS NOT NULL AND bank.sdk IS NOT NULL AND current.sdk<>bank.sdk THEN 1 ELSE 0 END AS sdkChanged,
    CASE WHEN current.bankId IS NOT NULL AND bank.bankId IS NOT NULL AND current.bankId<>bank.bankId THEN 1 ELSE 0 END AS bankChanged,
    CASE WHEN current.state='completed' AND current.decision='scored' AND previous.bankId=current.bankId AND previous.sdk=current.sdk AND previous.predictionId<>current.predictionId THEN 1 ELSE 0 END AS candidateChanged
  FROM linked current LEFT JOIN ordered previous ON previous.seq=current.scoredSeq LEFT JOIN ordered bank ON bank.seq=current.bankSeq
)`;
const json = (value) => JSON.stringify(value);

export class Store {
  constructor(file = ':memory:') {
    this.db = new Database(file, { create: true });
    const version = this.db.query('PRAGMA user_version').get().user_version;
    if (version > 2) { this.db.close(); throw new Error('数据库版本高于当前插件，请更新插件'); }
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS configurations (
        model TEXT PRIMARY KEY, value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS records (
        id TEXT PRIMARY KEY, model TEXT NOT NULL, name TEXT NOT NULL,
        started_at INTEGER NOT NULL, finished_at INTEGER, duration INTEGER,
        state TEXT NOT NULL, source TEXT NOT NULL, snapshot TEXT NOT NULL,
        answer TEXT NOT NULL DEFAULT '', automatic TEXT NOT NULL,
        call_error TEXT, manual_result TEXT, manual_note TEXT, manual_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS records_model_time ON records(model,started_at DESC);
      CREATE TABLE IF NOT EXISTS corrections (
        id INTEGER PRIMARY KEY AUTOINCREMENT, record_id TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE,
        at INTEGER NOT NULL, previous TEXT, next TEXT, note TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS service_owner (id INTEGER PRIMARY KEY CHECK(id=1), pid INTEGER NOT NULL, token TEXT NOT NULL);
      `);
    if (version < 2) this.db.transaction(() => {
      if (this.db.query('PRAGMA user_version').get().user_version === 2) return;
      const owner = this.db.query('SELECT pid FROM service_owner WHERE id=1').get();
      if (owner) {
        let alive = true; try { process.kill(owner.pid, 0); } catch (e) { alive = e.code !== 'ESRCH'; }
        if (alive) throw new Error('请先停止旧检测服务，再迁移数据库');
      }
      this.db.exec(`ALTER TABLE configurations RENAME TO configurations_v1;
        CREATE TABLE configurations (model TEXT NOT NULL, test_id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(model,test_id));
        INSERT INTO configurations SELECT model,'milk',json_set(value,'$.testId','milk') FROM configurations_v1;
        INSERT INTO configurations SELECT model,'fingerprint',json_set(value,'$.testId','fingerprint','$.enabled',json('false'),'$.intervalMinutes',NULL,'$.nextAt',NULL,'$.effort','','$.timeoutSeconds',300) FROM configurations_v1;
        DROP TABLE configurations_v1;
        ALTER TABLE records ADD COLUMN test_id TEXT NOT NULL DEFAULT 'milk';
        ALTER TABLE records ADD COLUMN fingerprint TEXT;
        CREATE INDEX records_type_time ON records(model,test_id,started_at DESC);
        PRAGMA user_version=2;`);
    }).immediate();
    this.db.exec(`CREATE TEMP TABLE history_revisions(model TEXT, test_id TEXT, revision INTEGER NOT NULL, PRIMARY KEY(model,test_id))`);
    for (const [event, row] of [['INSERT', 'NEW'], ['UPDATE', 'NEW'], ['DELETE', 'OLD']]) {
      this.db.exec(`CREATE TEMP TRIGGER revision_${event} AFTER ${event} ON main.records BEGIN
        INSERT INTO history_revisions VALUES(${row}.model,${row}.test_id,1)
        ON CONFLICT(model,test_id) DO UPDATE SET revision=revision+1; END`);
    }
  }
  acquire(token) {
    this.db.transaction(() => {
      const owner = this.db.query('SELECT pid FROM service_owner WHERE id=1').get();
      if (owner) {
        let alive = true;
        try { process.kill(owner.pid, 0); } catch (e) { alive = e.code !== 'ESRCH'; }
        if (alive) throw new Error('该数据目录已由另一个检测服务使用，请使用同一个服务端口');
      }
      this.db.query('INSERT OR REPLACE INTO service_owner VALUES(1,?,?)').run(process.pid, token);
    }).immediate();
  }
  release(token) { this.db.query('DELETE FROM service_owner WHERE id=1 AND token=?').run(token); }
  configs() { return this.db.query('SELECT value FROM configurations ORDER BY rowid').all().map(r => JSON.parse(r.value)); }
  config(model, type = 'milk') {
    const row = this.db.query('SELECT value FROM configurations WHERE model=? AND test_id=?').get(model, testId(type));
    return row ? JSON.parse(row.value) : null;
  }
  saveConfig(config) {
    this.db.transaction(() => this.db.query('INSERT INTO configurations(model,test_id,value) VALUES(?,?,?) ON CONFLICT(model,test_id) DO UPDATE SET value=excluded.value').run(config.model, testId(config.testId), json({ ...config, testId: testId(config.testId) })))();
    return config;
  }
  saveModelConfigs(configs) {
    return this.db.transaction(() => configs.map(config => this.saveConfig(config)))();
  }
  deleteConfig(model) { this.db.transaction(() => this.db.query('DELETE FROM configurations WHERE model=?').run(model))(); }
  historyRevisions() {
    return this.db.query('SELECT model,test_id AS testId,revision FROM history_revisions ORDER BY model,test_id').all();
  }
  historyModels(configs = this.configs(), revisions = this.historyRevisions()) {
    const models = new Map(configs.map(c => [c.model, { model: c.model, name: c.name, removed: false }]));
    const key = JSON.stringify(revisions);
    if (this.historyModelKey !== key) {
      this.recordModels = this.db.query('SELECT model,name FROM records GROUP BY model ORDER BY MAX(started_at) DESC').all();
      this.historyModelKey = key;
    }
    for (const r of this.recordModels)
      if (!models.has(r.model)) models.set(r.model, { ...r, removed: true });
    return [...models.values()];
  }
  create(snapshot, source, now = Date.now()) {
    const id = crypto.randomUUID();
    this.db.query(`INSERT INTO records(id,model,name,started_at,state,source,snapshot,automatic,test_id) VALUES(?,?,?,?,'queued',?,?,?,?)`)
      .run(id, snapshot.model, snapshot.name, now, source, json(snapshot), json({ result: 'unknown', extracted: null, reason: '尚未完成' }), testId(snapshot.testId));
    return this.detail(id);
  }
  start(id, now = Date.now()) {
    this.db.query("UPDATE records SET state='running',started_at=? WHERE id=? AND state='queued'").run(now, id);
  }
  evidence(id, fingerprint) {
    this.db.query("UPDATE records SET fingerprint=? WHERE id=? AND state IN ('queued','running')").run(json(fingerprint), id);
  }
  finish(id, { state = 'completed', answer = '', automatic, error = null }, now = Date.now()) {
    this.db.transaction(() => this.db.query(`UPDATE records SET state=?,answer=?,automatic=?,call_error=?,finished_at=?,duration=MAX(0,?-started_at) WHERE id=? AND state IN ('queued','running')`)
      .run(state, answer, json(automatic || { result: 'unknown', extracted: null, reason: error || '调用未正常完成' }), error, now, now, id))();
    return this.detail(id);
  }
  detail(id) {
    const r = this.db.query(`SELECT ${summaryColumns},snapshot,answer,automatic,fingerprint,manual_result AS manualResult,manual_note AS manualNote,manual_at AS manualAt FROM records WHERE id=?`).get(id);
    if (!r) throw new HTTPError(404, '记录不存在或已清空');
    r.fingerprint = r.fingerprint ? JSON.parse(r.fingerprint) : null; r.snapshot = JSON.parse(r.snapshot); r.automatic = JSON.parse(r.automatic); r.corrected = !!r.corrected;
    r.corrections = this.db.query('SELECT at,previous,next,note FROM corrections WHERE record_id=? ORDER BY id').all(id);
    return r;
  }
  correct(id, result, note = '', now = Date.now()) {
    if (result !== null && !['passed', 'failed', 'unknown'].includes(result)) throw new HTTPError(400, '人工结果无效');
    if (typeof note !== 'string' || note.length > 2000) throw new HTTPError(400, '备注最多 2000 字符');
    this.db.transaction(() => {
      const record = this.detail(id);
      if (record.testId !== 'milk') throw new HTTPError(400, '指纹结果不支持人工矫正');
      if (['queued', 'running'].includes(record.state)) throw new HTTPError(409, '测试完成后才可人工矫正');
      if (result === null && record.manualResult === null) return;
      this.db.query('INSERT INTO corrections(record_id,at,previous,next,note) VALUES(?,?,?,?,?)').run(id, now, record.manualResult, result, note);
      this.db.query('UPDATE records SET manual_result=?,manual_note=?,manual_at=? WHERE id=?').run(result, result === null ? null : note, result === null ? null : now, id);
    })();
    return this.detail(id);
  }
  list(model, page = 1, from = null, to = null, type = 'milk', changes = false) {
    if (type === 'fingerprint') {
      const where = '(? IS NULL OR startedAt>=?) AND (? IS NULL OR startedAt<?) AND (?=0 OR candidateChanged=1 OR bankChanged=1)';
      const params = [model, from, from, to, to, Number(changes)];
      const total = this.db.query(`${fingerprintHistory} SELECT COUNT(*) AS n FROM annotated WHERE ${where}`).get(...params).n;
      const items = this.db.query(`${fingerprintHistory} SELECT * FROM annotated WHERE ${where} ORDER BY seq DESC LIMIT 20 OFFSET ?`).all(...params, (page - 1) * 20).map(({ seq, bankSeq, scoredSeq, ...r }) => ({ ...r, corrected: !!r.corrected, candidateChanged: !!r.candidateChanged, bankChanged: !!r.bankChanged }));
      return { items, total, page, pageSize: 20 };
    }
    const where = 'model=? AND test_id=? AND (? IS NULL OR started_at>=?) AND (? IS NULL OR started_at<?)';
    const params = [model, testId(type), from, from, to, to];
    const total = this.db.query(`SELECT COUNT(*) AS n FROM records WHERE ${where}`).get(...params).n;
    const items = this.db.query(`SELECT ${summaryColumns} FROM records WHERE ${where} ORDER BY started_at DESC,rowid DESC LIMIT 20 OFFSET ?`).all(...params, (page - 1) * 20);
    return { items: items.map(r => ({ ...r, corrected: !!r.corrected })), total, page, pageSize: 20 };
  }
  fingerprintOverview(model, days = 7, now = Date.now()) {
    const from = now - days * 86400000;
    const total = this.db.query("SELECT COUNT(*) AS n FROM records WHERE model=? AND test_id='fingerprint' AND started_at>=? AND started_at<=?").get(model, from, now).n;
    const items = this.db.query(`${fingerprintHistory} SELECT id,startedAt,state,prediction,predictionId,probability,decision,usedOutputs,bankId,bankBuiltAt,sdk,bankChanged,sdkChanged,candidateChanged,callError FROM annotated WHERE startedAt>=? AND startedAt<=? ORDER BY seq DESC LIMIT 10000`).all(model, from, now).reverse();
    return { from, to: now, days, total, omitted: total - items.length, items };
  }
  fingerprintSummary(model, now = Date.now()) {
    const from = now - 30 * 86400000;
    const counts = this.db.query(`${fingerprintHistory} SELECT COUNT(*) AS total,
      COALESCE(SUM(state='completed' AND decision='scored'),0) AS scored,
      COALESCE(SUM(state='completed' AND decision='partial'),0) AS partial,
      COALESCE(SUM(candidateChanged),0) AS changes,
      COALESCE(SUM(bankChanged),0) AS bankChanges
      FROM annotated WHERE startedAt>=? AND startedAt<=?`).get(model, from, now);
    return { ...counts, from, to: now };
  }
  clear(model, type = 'milk') {
    // Only terminal rows are removed. In-flight work is a new result once it completes.
    return this.db.transaction(() => {
      this.db.query("DELETE FROM records WHERE model=? AND test_id=? AND state NOT IN ('queued','running')").run(model, testId(type));
      return this.db.query('SELECT changes() AS deleted').get().deleted;
    })();
  }
  repair(now = Date.now()) {
    this.db.query(`UPDATE records SET state='interrupted',finished_at=?,duration=MAX(0,?-started_at),call_error='插件服务重启，测试已中断',fingerprint=CASE WHEN fingerprint IS NOT NULL THEN json_set(fingerprint,'$.analysis',NULL,'$.error','插件服务重启，本轮不评分') ELSE NULL END WHERE state IN ('queued','running')`).run(now, now);
  }
  heatmap(model, timeZone, now = Date.now()) {
    const date = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
    const hour = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', hourCycle: 'h23' });
    const today = date.format(now);
    const dates = Array.from({ length: 30 }, (_, i) => {
      const d = new Date(`${today}T12:00:00Z`); d.setUTCDate(d.getUTCDate() - 29 + i);
      return d.toISOString().slice(0, 10);
    });
    const cells = new Map(dates.flatMap(day => Array.from({ length: 4 }, (_, slot) => [`${day}/${slot}`, { day, slot, result: 'empty', count: 0, passed: 0, failed: 0, unknown: 0, error: 0, pending: 0 }])));
    const rows = this.db.query(`SELECT started_at AS at,${effective} AS result FROM records WHERE model=? AND test_id='milk' AND started_at>=?`).all(model, now - 32 * 86400000);
    for (const r of rows) {
      const cell = cells.get(`${date.format(r.at)}/${Math.floor(Number(hour.format(r.at)) / 6)}`);
      if (!cell) continue;
      if (r.result === 'queued' || r.result === 'running') { cell.pending++; continue; }
      cell.count++; cell[r.result]++;
      cell.result = cell.failed ? 'failed' : cell.error || cell.unknown ? 'error' : 'passed';
    }
    return { dates, cells: [...cells.values()], timeZone };
  }
  close() { this.db.close(); }
}
