import fs from "fs";
import PDFDocument from "pdfkit";

export function gerarRelatorioProcedimentos(
  page: number,
  procedimentos: {
    id: number;
    patient_id: number | null;
    patientData?: any;
  }[]
) {
  const doc = new PDFDocument({ margin: 40 });
  const nomeArquivo = `./logs/relatorio_procedimentos_page_${page}.pdf`;

  // Garante a pasta /logs
  if (!fs.existsSync("./logs")) fs.mkdirSync("./logs");

  doc.fontSize(20).text(`Relatório de Procedimentos - Página ${page}`, {
    align: "center",
  });
  doc.moveDown();

  procedimentos.forEach((proc, idx) => {
    doc.fontSize(14).text(`Procedimento #${idx + 1}`, { underline: true });
    doc.fontSize(12).text(`ID: ${proc.id}`);
    doc.text(`Patient ID: ${proc.patient_id ?? "null"}`);

    if (proc.patientData) {
      const p = proc.patientData;
      doc.text(`Nome: ${p.name}`);
      doc.text(`CPF: ${p.cpf ?? "Não informado"}`);
      doc.text(`PDFs: ${p.pdf?.length ?? 0}`);

      if (p.pdf && p.pdf.length > 0) {
        p.pdf.forEach((pdfItem: any) => {
          doc.text(
            `  → PDF ID ${pdfItem.id} | Tipo: ${pdfItem.type} | Procedure: ${pdfItem.procedure_id}`
          );
        });
      }
    }

    doc.moveDown();
  });

  doc.end();
  doc.pipe(fs.createWriteStream(nomeArquivo));

  console.log(`📄 PDF gerado: ${nomeArquivo}`);
}
