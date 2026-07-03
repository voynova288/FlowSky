import { RequestLogger, type RequestLogEntry } from "../observability/RequestLogger.ts";
import { SqliteStateStore } from "./SqliteStateStore.ts";

export class SqliteRequestLogger extends RequestLogger {
  private readonly stateStore: SqliteStateStore;

  constructor(stateStore: SqliteStateStore) {
    super();
    this.stateStore = stateStore;
  }

  override record(entry: RequestLogEntry): void {
    super.record(entry);
    this.stateStore.recordAudit(entry);
  }
}
