import "dotenv/config";
import fs from "fs/promises";
import axios, { AxiosError } from "axios";
import { DateTime } from "luxon";

const axiosInstance = axios.create({
  baseURL: process.env.AXREG_URL,
  headers: {
    "Content-Type": "application/json",
    Accept: "application/json",
    "institution-key": process.env.AXREG_INSTITUTION_KEY,
    "integrator-key": process.env.AXREG_INTEGRATOR_KEY,
  },
});

async function main() {
  try {
    // const updatedAfter = "2000-01-01 00:00:00";
    const updatedAfter = DateTime.now()
      .minus({ months: 1 })
      .startOf("day")
      .toFormat("yyyy-LL-dd HH:mm:ss");
    const limit = 400;
    let page = 1;
    let allResults: any[] = [];
    while (true) {
      const response = await axiosInstance.get("/v3/procedures", {
        params: {
          updated_after: "2025-10-15 00:00:00",
          page,
          limit,
        },
      });
      const data = response.data.data;

      console.log(data)
      console.log(
        `Fetched page ${page}, received ${data.length} records, total so far: ${
          allResults.length + data.length
        }`
      );
      if (!data || data.length === 0) break;
      allResults = allResults.concat(data);
      page++;
    }

    await fs.writeFile("output.json", JSON.stringify(allResults, null, 2));

    console.log({
      length: allResults.length,
      with_pdfs: allResults.filter(
        (item: any) => item.procedure_pdfs.length > 0
      ).length,
    });
  } catch (error) {
    if (error instanceof AxiosError) {
      console.error("Error response data:", error.response?.data);
      console.error("Error response status:", error.response?.status);
      console.error("Error response headers:", error.response?.headers);
    }
  }
}

 main();

/* async function downloadPdf() {
  const response = await axiosInstance.get(`/patients/996935273`);

  await fs.writeFile("output-patient.json", JSON.stringify(response.data, null, 2));
}

downloadPdf(); */
