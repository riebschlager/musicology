export type SqliteValue = bigint | Buffer | number | string | null;

export type SqliteNamedParameters = Readonly<Record<string, SqliteValue>>;
export type SqliteParameters = readonly SqliteValue[] | SqliteNamedParameters;
export type SqliteRow = Readonly<Record<string, unknown>>;

export interface StatementRunResult {
  readonly changes: number;
  readonly lastInsertRowid: bigint | number;
}

export interface PreparedStatement<Row extends SqliteRow = SqliteRow> {
  run(parameters?: SqliteParameters): StatementRunResult;
  get(parameters?: SqliteParameters): Row | undefined;
  all(parameters?: SqliteParameters): readonly Row[];
  iterate(parameters?: SqliteParameters): IterableIterator<Row>;
}

export type TransactionMode = "deferred" | "exclusive" | "immediate";

export interface ForeignKeyViolation {
  readonly table: string;
  readonly rowId: number | null;
  readonly parentTable: string;
  readonly foreignKeyIndex: number;
}

export interface IntegrityCheckResult {
  readonly ok: boolean;
  readonly messages: readonly string[];
  readonly foreignKeyViolations: readonly ForeignKeyViolation[];
}

/** Project-owned boundary for synchronous SQLite access. */
export interface SqliteConnection {
  readonly databasePath: string;
  readonly isOpen: boolean;
  readonly isInTransaction: boolean;

  execute(sql: string): void;
  prepare<Row extends SqliteRow = SqliteRow>(sql: string): PreparedStatement<Row>;
  transaction<T>(operation: (connection: SqliteConnection) => T, mode?: TransactionMode): T;
  checkIntegrity(): IntegrityCheckResult;
  close(): void;
}
