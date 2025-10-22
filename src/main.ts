import "dotenv/config";
import sql from "mssql";
import axios, { AxiosError } from "axios";
import { DateTime } from "luxon";
import { db } from "./db";
import { gerarRelatorioProcedimentos } from "./debugReport";
import { logProcessingError } from "./errorLogger";

/* =========================
   Tipos
========================= */
interface Procedure {
  id: number;
  patient_id: number | null;
}
interface ProceduresResponse {
  data?: Procedure[];
}
interface PatientPdfInfo {
  id: number;
  procedure_id: number;
  name: string;
  type: string;
  created_at: string; // <-- necessário para filtrar últimas 24h
}
interface PatientResponseData {
  id: number;
  name: string;
  cpf?: string | null;
  pdf?: PatientPdfInfo[] | null;
}
interface PatientResponse {
  data?: PatientResponseData;
}

/* =========================
   Axios
========================= */
const axiosJSON = axios.create({
  baseURL: process.env.AXREG_URL,
  headers: {
    "Content-Type": "application/json",
    Accept: "application/json",
    "institution-key": process.env.AXREG_INSTITUTION_KEY,
    "integrator-key": process.env.AXREG_INTEGRATOR_KEY,
  },
});
const axiosPDF = axios.create({
  baseURL: process.env.AXREG_URL,
  headers: {
    Accept: "application/pdf",
    "institution-key": process.env.AXREG_INSTITUTION_KEY,
    "integrator-key": process.env.AXREG_INTEGRATOR_KEY,
  },
});

/* =========================
   Helpers AxReg
========================= */
async function fetchProcedures(
  updatedAfter: string,
  limit = 200
): Promise<(Procedure & { patientData?: PatientResponseData | null })[]> {
  const procedures: (Procedure & {
    patientData?: PatientResponseData | null;
  })[] = [];
  let page = 1;

  while (true) {
    const res = await axiosJSON.get<ProceduresResponse>("/v3/procedures", {
      params: { updated_after: updatedAfter, page, limit },
    });
    const data = res.data?.data ?? [];
    if (data.length === 0) break;

    // Enriquecimento (para gerar PDF de diagnóstico)
    const enriched = await Promise.all(
      data.map(async (p) => {
        let patientData: PatientResponseData | null = null;
        if (p.patient_id) {
          patientData = await fetchPatient(p.patient_id);
        }
        return { ...p, patientData };
      })
    );

    // Gera PDF de diagnóstico da página atual
    gerarRelatorioProcedimentos(page, enriched);

    procedures.push(...enriched);
    console.log(`📄 Página ${page} → ${data.length} procedimentos`);
    if (data.length < limit) break;
    page++;
  }

  return procedures;
}

async function fetchPatient(
  patientId: number
): Promise<PatientResponseData | null> {
  try {
    const res = await axiosJSON.get<PatientResponse>(`/patients/${patientId}`);
    return res.data?.data ?? null;
  } catch (e) {
    if (e instanceof AxiosError) {
      console.error(
        `Erro ao buscar paciente ${patientId}:`,
        e.response?.status
      );
      // 🔴 LOG: erro HTTP ao consultar paciente
      logProcessingError({
        reason: "PATIENT_FETCH_FAIL",
        patientId,
        details: `HTTP ${e.response?.status ?? "?"} em /patients/${patientId}`,
      });
    }
    return null;
  }
}

async function fetchPdfAsBase64(pdfId: number): Promise<string | null> {
  try {
    const res = await axiosPDF.get<ArrayBuffer>(`/pdfs/${pdfId}`, {
      responseType: "arraybuffer",
    });
    return Buffer.from(res.data).toString("base64");
  } catch (e) {
    if (e instanceof AxiosError) {
      console.error(`Erro ao baixar PDF ${pdfId}:`, e.response?.status);
      // 🔴 LOG: falha no download do PDF
      logProcessingError({
        reason: "DOWNLOAD_FAIL",
        pdfId,
        details: `HTTP ${e.response?.status ?? "?"} em /pdfs/${pdfId}`,
      });
    }
    return null;
  }
}

async function buscarPacienteEAtendimento(
  pool: sql.ConnectionPool,
  cpf: string
): Promise<{ codPaciente: string; codAtendimento: string } | null> {
  if (!cpf) return null;

  const result = await pool.request().input("CPF", sql.NVarChar(20), cpf)
    .query(`
      SELECT TOP 1
        CAST(A.CODPACIENTE    AS NVARCHAR(50)) AS CODPACIENTE,
        CAST(B.CODATENDIMENTO AS NVARCHAR(50)) AS CODATENDIMENTO
      FROM SZPACIENTE (NOLOCK) A
      JOIN SZATENDIMENTO (NOLOCK) B
        ON A.CODCOLIGADA = B.CODCOLIGADA
       AND A.CODPACIENTE = B.CODPACIENTE
      WHERE A.CPF = @CPF
      ORDER BY B.CODATENDIMENTO DESC
    `);

  if (result.recordset.length === 0) return null;

  const codPaciente = (result.recordset[0].CODPACIENTE ?? "").toString().trim();
  const codAtendimento = (result.recordset[0].CODATENDIMENTO ?? "")
    .toString()
    .trim();
  if (!codPaciente || !codAtendimento) return null;

  return { codPaciente, codAtendimento };
}

async function reservarProximoIdArquivo(tx: sql.Transaction): Promise<{
  idArquivo: number;
  gautoincAntes: number;
  gautoincDepois: number;
  maxSzAntes: number;
}> {
  const req = new sql.Request(tx);
  const q = `
    -- Bloqueia linha da GAUTOINC e lê valor atual
    DECLARE @Atual INT, @MaxSZ INT, @Next INT;

    SELECT @Atual = VALAUTOINC
      FROM GAUTOINC WITH (UPDLOCK, HOLDLOCK, ROWLOCK)
     WHERE CODAUTOINC = 'IDARQUIVO'
       AND CODCOLIGADA = 1;

    -- Bloqueia base de SZARQUIVO o suficiente pra evitar corrida de MAX
    SELECT @MaxSZ = ISNULL(MAX(IDARQUIVO), 0)
      FROM SZARQUIVO WITH (UPDLOCK, HOLDLOCK)
     WHERE CODCOLIGADA = 1;

    SET @Next = CASE WHEN @MaxSZ >= @Atual THEN @MaxSZ + 1 ELSE @Atual + 1 END;

    UPDATE GAUTOINC
       SET VALAUTOINC = @Next
     WHERE CODAUTOINC = 'IDARQUIVO'
       AND CODCOLIGADA = 1;

    SELECT
      @Atual     AS GAUTOINC_ANTES,
      @MaxSZ     AS MAX_SZ_ANTES,
      @Next      AS ID_ESCOLHIDO,
      (SELECT VALAUTOINC FROM GAUTOINC WHERE CODAUTOINC='IDARQUIVO' AND CODCOLIGADA=1) AS GAUTOINC_DEPOIS;
  `;
  const r = await req.query(q);
  const row = r.recordset[0];
  return {
    idArquivo: row.ID_ESCOLHIDO,
    gautoincAntes: row.GAUTOINC_ANTES,
    gautoincDepois: row.GAUTOINC_DEPOIS,
    maxSzAntes: row.MAX_SZ_ANTES,
  };
}

function tsqlEscape(str: string) {
  return str.replace(/'/g, "''");
}
function buildInsertPreview({
  idArquivo,
  codPaciente,
  codAtendimento,
  nomeArquivo,
  descricao,
  base64,
}: {
  idArquivo: number;
  codPaciente: string;
  codAtendimento: string;
  nomeArquivo: string;
  descricao: string;
  base64: string;
}) {
  const base64Preview =
    base64.slice(0, 120) + (base64.length > 120 ? "...(truncado)" : "");
  return `
/* ===== PREVIEW DO INSERT EM SZARQUIVO (copie/cole no SQL Server) ===== */
DECLARE @BASE NVARCHAR(MAX) = N'${tsqlEscape(
    base64
  )}'; -- (no console mostramos só o início: '${tsqlEscape(base64Preview)}')
DECLARE @BIN VARBINARY(MAX);

SET @BIN = CAST(N'' AS XML).value('xs:base64Binary(sql:variable("@BASE"))', 'VARBINARY(MAX)');

INSERT INTO SZARQUIVO (
  CODCOLIGADA, IDARQUIVO, CODPACIENTE, CODATENDIMENTO, DATAINCLUSAO,
  NOMEARQUIVO, DESCRICAO,
  RECCREATEDBY, RECCREATEDON, RECMODIFIEDBY, RECMODIFIEDON, ARQUIVO
)
VALUES (
  1, ${idArquivo}, N'${tsqlEscape(codPaciente)}', N'${tsqlEscape(
    codAtendimento
  )}', GETDATE(),
  N'${tsqlEscape(nomeArquivo)}', N'${tsqlEscape(descricao)}',
  'AUTOMACAOAXREG', GETDATE(), 'AUTOMACAOAXREG', GETDATE(), @BIN
);
/* ===================================================================== */
`.trim();
}

/* =========================
   MAIN
========================= */
async function main() {
  const pool = await db;
  console.log("✅ Conectado ao banco de dados RM com sucesso!");

  // Mesma referência temporal usada no updated_after e para filtrar PDFs
  const updatedAfter = DateTime.now()
    .minus({ hours: 24 })
    .toISO({ suppressMilliseconds: true });
  const since = DateTime.fromISO(updatedAfter).toUTC();

  console.log(`⏱️ Buscando procedimentos atualizados após ${updatedAfter}`);

  // Agora fetchProcedures retorna também patientData (usado no diagnóstico)
  const procedures = await fetchProcedures(updatedAfter, 200);
  console.log(
    `Encontrados ${procedures.length} procedimentos nas últimas 24h.`
  );

  let totalInseridosZMD = 0;
  let totalInseridosSZ = 0;
  let totalPulados = 0;

  await Promise.all(
    procedures.map(async (procedure) => {
      try {
        if (!procedure.patient_id) return;

        const patient =
          procedure.patientData ?? (await fetchPatient(procedure.patient_id));
        if (!patient) return;

        // Todos os PDFs TRANS do MESMO procedimento e dentro da janela
        const matchingPdfs = (patient.pdf ?? [])
          .filter((p) => {
            if (p.type !== "TRANS") return false;
            if (p.procedure_id !== procedure.id) return false;
            // created_at é obrigatório para entrar no filtro
            const created = (p as any).created_at;
            if (!created) {
              // 🔴 LOG: PDF sem created_at
              logProcessingError({
                reason: "NO_CREATED_AT",
                patientId: patient.id,
                patientName: patient.name,
                cpf: patient.cpf ?? "",
                pdfId: p.id,
                procedureId: procedure.id,
                details:
                  "PDF sem created_at; não foi possível checar janela de 24h.",
              });
              return false;
            }
            const dt = DateTime.fromISO(created).toUTC();
            return dt >= since;
          })
          // opcional: processar do mais antigo para o mais novo
          .sort(
            (a, b) =>
              DateTime.fromISO((a as any).created_at).toMillis() -
              DateTime.fromISO((b as any).created_at).toMillis()
          );

        if (matchingPdfs.length === 0) return;

        // Itera por todos os PDFs válidos (regra do Lucas)
        for (const pdf of matchingPdfs) {
          const rawCpf = patient.cpf || "";
          const cpf = rawCpf.replace(/\D/g, "");

          // 1) Dedupe exclusivo pela ZMD
          const checkZMD = await pool
            .request()
            .input("ID_PDF_AXREG", pdf.id)
            .query(
              `SELECT COUNT(*) AS COUNT FROM ZMDIDAXREG WHERE ID_PDF_AXREG = @ID_PDF_AXREG`
            );

          if (checkZMD.recordset[0].COUNT > 0) {
            console.log(
              `⚠️ PDF ${pdf.id} já registrado na ZMD. Pulando (PAC ${patient.id} - ${patient.name}).`
            );
            totalPulados++;
            continue;
          }

          // 🔴 LOG: Paciente sem CPF
          if (!cpf) {
            console.log(
              `⚠️ Paciente sem CPF: ${patient.name} (ID ${patient.id}). Pulando PDF ${pdf.id}.`
            );
            logProcessingError({
              reason: "NO_CPF",
              patientId: patient.id,
              patientName: patient.name,
              cpf: rawCpf,
              pdfId: pdf.id,
              procedureId: procedure.id,
              details:
                "Paciente sem CPF cadastrado; não é possível localizar atendimento no RM.",
            });
            continue;
          }

          // 2) Busca atendimento por CPF (mantida sua regra)
          const dadosPaciente = await buscarPacienteEAtendimento(pool, cpf);
          if (!dadosPaciente) {
            console.log(
              `⚠️ Sem atendimento para ${patient.name} (${cpf}). Pulando PDF ${pdf.id}.`
            );
            // 🔴 LOG: Sem atendimento
            logProcessingError({
              reason: "NO_ATENDIMENTO",
              patientId: patient.id,
              patientName: patient.name,
              cpf,
              pdfId: pdf.id,
              procedureId: procedure.id,
              details:
                "Nenhum atendimento encontrado em SZATENDIMENTO para este CPF.",
            });
            continue;
          }
          const { codPaciente, codAtendimento } = dadosPaciente;
          const codPacStr = String(codPaciente ?? "").trim();
          const codAtdStr = String(codAtendimento ?? "").trim();
          if (!codPacStr || !codAtdStr) {
            console.warn(
              `⚠️ CODPACIENTE/CODATENDIMENTO vazio para ${patient.name}. Pulando PDF ${pdf.id}.`
            );
            // 🔴 LOG: chaves RM vazias
            logProcessingError({
              reason: "RM_KEYS_EMPTY",
              patientId: patient.id,
              patientName: patient.name,
              cpf,
              pdfId: pdf.id,
              procedureId: procedure.id,
              details: `codPaciente='${codPacStr}' codAtendimento='${codAtdStr}'`,
            });
            continue;
          }

          // 3) Baixa PDF binário
          const base64 = await fetchPdfAsBase64(pdf.id);
          if (!base64) {
            console.warn(
              `❌ Falha ao baixar PDF ${pdf.id} (${patient.name}). Pulando.`
            );
            // 🔴 LOG: falha de download (reforço caso não tenha sido pego no fetch)
            logProcessingError({
              reason: "DOWNLOAD_FAIL",
              patientId: patient.id,
              patientName: patient.name,
              cpf,
              pdfId: pdf.id,
              procedureId: procedure.id,
              details: "fetchPdfAsBase64 retornou null (HTTP erro/timeout).",
            });
            continue;
          }
          const buffer = Buffer.from(base64, "base64");
          const byteLen = buffer.length;

          // 4) Transação: GAUTOINC + INSERT em SZARQUIVO
          const tx = new sql.Transaction(pool);
          try {
            await tx.begin();

            const { idArquivo, gautoincAntes, gautoincDepois, maxSzAntes } =
              await reservarProximoIdArquivo(tx);

            const nomeArquivo = `ANEXO_PEP_AXREG${idArquivo}.pdf`;
            const descricao = `ANEXO_PEP_AXREG${pdf.id}`;

            console.log(
              [
                "🧩 INSERT DEBUG →",
                `  GAUTOINC antes.: ${gautoincAntes}`,
                `  MAX(SZ) antes..: ${maxSzAntes}`,
                `  ID escolhido...: ${idArquivo} (GAUTOINC depois = ${gautoincDepois})`,
                `  CODPACIENTE....: ${codPacStr}`,
                `  CODATENDIMENTO.: ${codAtdStr}`,
                `  NOMEARQUIVO....: ${nomeArquivo}`,
                `  DESCRICAO......: ${descricao}`,
                `  PDF bytes......: ${byteLen}`,
                `  PDF created_at.: ${(pdf as any).created_at}`,
              ].join("\n")
            );

            // (Opcional) Preview para SSMS
            const preview = buildInsertPreview({
              idArquivo,
              codPaciente: codPacStr,
              codAtendimento: codAtdStr,
              nomeArquivo,
              descricao,
              base64,
            });
            // console.log(preview);

            await new sql.Request(tx)
              .input("CODCOLIGADA", sql.Int, 1)
              .input("IDARQUIVO", sql.Int, idArquivo)
              .input("CODPACIENTE", sql.NVarChar(50), codPacStr)
              .input("CODATENDIMENTO", sql.NVarChar(50), codAtdStr)
              .input("NOMEARQUIVO", sql.NVarChar(255), nomeArquivo)
              .input("DESCRICAO", sql.NVarChar(255), descricao)
              .input("ARQUIVO", sql.VarBinary(sql.MAX), buffer).query(`
                INSERT INTO SZARQUIVO (
                  CODCOLIGADA, IDARQUIVO, CODPACIENTE, CODATENDIMENTO, DATAINCLUSAO,
                  NOMEARQUIVO, DESCRICAO,
                  RECCREATEDBY, RECCREATEDON, RECMODIFIEDBY, RECMODIFIEDON, ARQUIVO
                )
                VALUES (
                  @CODCOLIGADA, @IDARQUIVO, @CODPACIENTE, @CODATENDIMENTO, GETDATE(),
                  @NOMEARQUIVO, @DESCRICAO,
                  'AUTOMACAOAXREG', GETDATE(), 'AUTOMACAOAXREG', GETDATE(), @ARQUIVO
                )
            `);

            await tx.commit();

            // 5) Após COMMIT: registra na ZMD (trava oficial de duplicidade)
            await pool
              .request()
              .input("CODPACIENTE", patient.id)
              .input("NOME", patient.name)
              .input("CPF", cpf)
              .input("ID_PDF_AXREG", pdf.id).query(`
                INSERT INTO ZMDIDAXREG (CODPACIENTE, NOME, CPF, ID_PDF_AXREG)
                VALUES (@CODPACIENTE, @NOME, @CPF, @ID_PDF_AXREG)
              `);

            totalInseridosZMD++;
            totalInseridosSZ++;
            console.log(
              `✅ OK → PDF ${pdf.id} anexado (PAC ${codPacStr}, ATD ${codAtdStr}) e registrado na ZMD.`
            );
          } catch (err: any) {
            try {
              await tx.rollback();
            } catch {}
            console.error(
              `❌ Erro ao inserir SZARQUIVO para ${patient.name} com PDF ${pdf.id}:`,
              err
            );
            // 🔴 LOG: erro SQL
            logProcessingError({
              reason: "SQL_FAIL",
              patientId: patient.id,
              patientName: patient.name,
              cpf,
              pdfId: pdf.id,
              procedureId: procedure.id,
              details: String(err?.message ?? err),
            });
          }
        }
      } catch (err) {
        console.error(
          `❌ Erro ao processar procedimento ${procedure.id}:`,
          err
        );
        // 🔴 LOG: erro genérico por procedimento
        logProcessingError({
          reason: "PROC_FAIL",
          procedureId: procedure.id,
          details: String((err as any)?.message ?? err),
        });
      }
    })
  );

  console.log("🏁 Finalizado:");
  console.log(`   🧾 Inseridos na ZMDIDAXREG: ${totalInseridosZMD}`);
  console.log(`   📎 Inseridos na SZARQUIVO: ${totalInseridosSZ}`);
  console.log(`   ⚠️ Pulados (duplicados ZMD): ${totalPulados}`);
  try {
    await pool.close();
    console.log("🔌 Pool SQL fechado com sucesso!");
  } catch (e) {
    console.warn("⚠️ Falha ao fechar pool SQL:", e);
  }
}

main()
  .catch(console.error)
  .finally(() => {
    console.log("Encerrando processo.");
    process.exit(0);
  });
