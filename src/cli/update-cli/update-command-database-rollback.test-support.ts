import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  renderUpdateRunReport,
  updateRunReportInputFromResult,
} from "../../infra/update-run-report.js";
import type { UpdateRunResult } from "../../infra/update-runner-types.js";

export function readDatabase(file: string) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return {
      version: db.prepare("PRAGMA user_version").get()?.user_version,
      rows: db.prepare("SELECT rowid, value FROM payload ORDER BY rowid").all(),
      columns: db
        .prepare("PRAGMA table_info(payload)")
        .all()
        .map((column) => column.name),
    };
  } finally {
    db.close();
  }
}

/** The snapshot step's lifetime text, both as recorded and as the run report reprints it. */
export function snapshotLifetimeText(result: UpdateRunResult) {
  const captured = result.steps.find((step) => step.name === "database snapshot");
  return {
    step: [...(captured?.warnings ?? []), ...(captured?.diagnostics ?? [])].join("\n"),
    report: renderUpdateRunReport(updateRunReportInputFromResult(result)).lines.join("\n"),
  };
}

/**
 * Leaves `database` as a writer that exited just before capture would: a WAL family
 * with both sidecars and no holder. Copying it while open keeps the visible rows.
 */
export async function leaveExitedWriterWalFamily(database: string, scratch: string) {
  await fs.mkdir(scratch);
  {
    using writer = new DatabaseSync(database);
    writer.exec(
      "PRAGMA journal_mode=WAL; INSERT INTO payload(rowid,value) VALUES(1000,'transient'); DELETE FROM payload WHERE rowid=1000;",
    );
    for (const suffix of ["", "-wal", "-shm"]) {
      await fs.copyFile(`${database}${suffix}`, path.join(scratch, suffix || "db"));
    }
  }
  for (const suffix of ["", "-wal", "-shm"]) {
    await fs.copyFile(path.join(scratch, suffix || "db"), `${database}${suffix}`);
  }
}
