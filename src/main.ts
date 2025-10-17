import "dotenv/config";
import fs from "fs/promises";
import axios, { AxiosError } from "axios";
import { DateTime } from "luxon";

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
}

interface PatientResponseData {
  id: number;
  name: string;
  pdf?: PatientPdfInfo[] | null;
}

interface PatientResponse {
  data?: PatientResponseData;
}

const axiosInstance = axios.create({
  baseURL: process.env.AXREG_URL,
  headers: {
    "Content-Type": "application/json",
    Accept: "application/json",
    "institution-key": process.env.AXREG_INSTITUTION_KEY,
    "integrator-key": process.env.AXREG_INTEGRATOR_KEY,
  },
});

async function fetchProcedures(updatedAfter: string, limit = 400): Promise<Procedure[]> {
  const procedures: Procedure[] = [];
  let page = 1;

  while (true) {
    const response = await axiosInstance.get<ProceduresResponse>("/v3/procedures", {
      params: {
        updated_after: updatedAfter,
        page,
        limit,
      },
    });

    const data = response.data?.data ?? [];

    if (!Array.isArray(data) || data.length === 0) {
      break;
    }

    procedures.push(...data);
    console.log(
      `Fetched page ${page}, received ${data.length} records, total so far: ${procedures.length}`
    );

    if (data.length < limit) {
      break;
    }

    page++;
  }

  return procedures;
}

async function fetchPatient(patientId: number): Promise<PatientResponseData | null> {
  try {
    const response = await axiosInstance.get<PatientResponse>(`/patients/${patientId}`);
    return response.data?.data ?? null;
  } catch (error) {
    if (error instanceof AxiosError) {
      console.error(`Failed to fetch patient ${patientId}:`, error.response?.status);
    }
    return null;
  }
}

async function fetchPdfAsBase64(pdfId: number): Promise<string | null> {
  try {
    const response = await axiosInstance.get<ArrayBuffer>(`/pdfs/${pdfId}`, {
      responseType: "arraybuffer",
      headers: {
        Accept: "application/pdf",
      },
    });

    return Buffer.from(response.data).toString("base64");
  } catch (error) {
    if (error instanceof AxiosError) {
      console.error(`Failed to download PDF ${pdfId}:`, error.response?.status);
    }
    return null;
  }
}

async function main() {
  try {
    const updatedAfter =
      process.env.AXREG_UPDATED_AFTER ??
      DateTime.now().minus({ months: 1 }).startOf("day").toFormat("yyyy-LL-dd HH:mm:ss");

    const procedures = await fetchProcedures(updatedAfter);

    console.log(`Fetched ${procedures.length} procedures updated after ${updatedAfter}.`);

    const uniquePatientIds = Array.from(
      new Set(
        procedures
          .map((procedure) => procedure.patient_id)
          .filter((patientId): patientId is number => typeof patientId === "number")
      )
    );

    console.log(`Identified ${uniquePatientIds.length} unique patient IDs.`);

    const patientPdfs: {
      patient_id: number;
      patient_name: string;
      pdfs: (PatientPdfInfo & { base64: string })[];
    }[] = [];

    for (const patientId of uniquePatientIds) {
      const patient = await fetchPatient(patientId);

      if (!patient) {
        continue;
      }

      const pdfs = (patient.pdf ?? []).filter((pdf) => pdf.type === "TRANS");

      if (pdfs.length === 0) {
        continue;
      }

      const pdfEntries: (PatientPdfInfo & { base64: string })[] = [];

      for (const pdf of pdfs) {
        const base64 = await fetchPdfAsBase64(pdf.id);

        if (!base64) {
          continue;
        }

        pdfEntries.push({ ...pdf, base64 });
      }

      if (pdfEntries.length > 0) {
        patientPdfs.push({
          patient_id: patient.id,
          patient_name: patient.name,
          pdfs: pdfEntries,
        });
      }
    }

    await fs.writeFile("patient-pdfs.json", JSON.stringify(patientPdfs, null, 2));

    console.log(
      `Saved TRANS PDFs for ${patientPdfs.length} patients to patient-pdfs.json (total PDFs: ${patientPdfs.reduce(
        (total, entry) => total + entry.pdfs.length,
        0
      )}).`
    );
  } catch (error) {
    if (error instanceof AxiosError) {
      console.error("Error response data:", error.response?.data);
      console.error("Error response status:", error.response?.status);
      console.error("Error response headers:", error.response?.headers);
    } else {
      console.error(error);
    }
  }
}

main();
