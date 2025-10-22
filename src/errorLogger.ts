import fs from "fs";
import path from "path";
import { DateTime } from "luxon";

/**
 * Diretório de destino (ordem de prioridade):
 * 1) AXREG_ERRORS_DIR (se definido)
 * 2) Windows: UNC padrão \\172.17.0.97\zarquivos\Errors-AXREG
 * 3) Linux/mac: ponto de montagem local /mnt/axreg/Errors-AXREG
 */
const UNC_DEFAULT = "\\\\172.17.0.97\\zarquivos\\Errors-AXREG"; // Windows
const LINUX_DEFAULT = "/mnt/axreg/Errors-AXREG"; // Linux/mac (share montado)
const FALLBACK_LOCAL = path.resolve("./logs/errors");

// Define o alvo de escrita conforme SO / env
const TARGET_DIR_RAW =
  process.env.AXREG_ERRORS_DIR ||
  (process.platform === "win32" ? UNC_DEFAULT : LINUX_DEFAULT);

let announcedTarget = false;

function getDailyFilenames(baseDir: string) {
  const day = DateTime.now().toFormat("yyyyLLdd");
  const jsonl = path.join(baseDir, `axreg_errors_${day}.jsonl`);
  const csv = path.join(baseDir, `axreg_errors_${day}.csv`);
  return { jsonl, csv };
}

function ensureCsvHeader(csvPath: string) {
  if (!fs.existsSync(csvPath)) {
    fs.mkdirSync(path.dirname(csvPath), { recursive: true });
    fs.writeFileSync(
      csvPath,
      "when,reason,patientId,patientName,cpf,pdfId,procedureId,details\n",
      { encoding: "utf8" }
    );
  }
}

function appendBothFormats(baseDir: string, payload: any) {
  if (!announcedTarget) {
    console.log(`[AXREG][errors] destino: ${baseDir}`);
    announcedTarget = true;
  }

  const { jsonl, csv } = getDailyFilenames(baseDir);

  // Garante cabeçalho do CSV
  ensureCsvHeader(csv);

  // NDJSON
  fs.appendFileSync(jsonl, JSON.stringify(payload) + "\n", {
    encoding: "utf8",
  });

  // CSV (escapa aspas)
  const q = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const csvLine =
    [
      payload.when,
      payload.reason,
      payload.patientId,
      payload.patientName,
      payload.cpf,
      payload.pdfId,
      payload.procedureId,
      payload.details,
    ]
      .map(q)
      .join(",") + "\n";
  fs.appendFileSync(csv, csvLine, { encoding: "utf8" });
}

/**
 * Registra erro de processamento (append-only).
 * Se falhar gravar no destino escolhido, grava no fallback local.
 */
export function logProcessingError(entry: {
  reason: string;
  patientId?: number | string | null;
  patientName?: string | null;
  cpf?: string | null;
  pdfId?: number | string | null;
  procedureId?: number | string | null;
  details?: string | null;
}) {
  const when = DateTime.now().toISO();
  const safe = {
    when,
    reason: entry.reason,
    patientId: entry.patientId ?? "",
    patientName: entry.patientName ?? "",
    cpf: entry.cpf ?? "",
    pdfId: entry.pdfId ?? "",
    procedureId: entry.procedureId ?? "",
    details: entry.details ?? "",
  };

  try {
    fs.mkdirSync(TARGET_DIR_RAW, { recursive: true });
    appendBothFormats(TARGET_DIR_RAW, safe);
  } catch (e) {
    // Falhou (ex.: share não montado/permissão). Vai para fallback local.
    try {
      fs.mkdirSync(FALLBACK_LOCAL, { recursive: true });
      appendBothFormats(FALLBACK_LOCAL, safe);
      if (!(global as any).__AXREG_LOGGER_WARNED__) {
        console.warn(
          `[AXREG][WARN] Não foi possível gravar em "${TARGET_DIR_RAW}". Usando fallback local: ${FALLBACK_LOCAL}`
        );
        (global as any).__AXREG_LOGGER_WARNED__ = true;
      }
    } catch (e2) {
      console.error(
        "[AXREG][ERROR] Falha ao gravar logs de erro no fallback local:",
        e2
      );
    }
  }
}
