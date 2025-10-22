import fs from "fs";
import path from "path";
import { DateTime } from "luxon";

/**
 * Diretório de destino:
 * 1) AXREG_ERRORS_DIR (se definido)
 * 2) UNC padrão \\172.17.0.97\zarquivos\Errors-AXREG
 * 3) fallback local ./logs/errors (se der erro ao gravar no UNC)
 */
const UNC_DEFAULT = "\\\\172.17.0.97\\zarquivos\\Errors-AXREG";
const FALLBACK_LOCAL = path.resolve("./logs/errors");

// Se vier via env, respeita; senão usa o UNC padrão
const TARGET_DIR_RAW = process.env.AXREG_ERRORS_DIR || UNC_DEFAULT;

// Em Windows, o UNC funciona nativamente. Em Linux, precisa montar SMB
// Em ambos os casos, vamos tentar gravar no TARGET_DIR_RAW e, se falhar,
// gravamos no fallback local.
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
 * Se falhar gravar no UNC, grava no fallback local e imprime aviso.
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
    // Falhou gravar no UNC (permissão/rota/SMB). Vai para fallback local.
    try {
      fs.mkdirSync(FALLBACK_LOCAL, { recursive: true });
      appendBothFormats(FALLBACK_LOCAL, safe);
      // Loga um alerta único por processo
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
