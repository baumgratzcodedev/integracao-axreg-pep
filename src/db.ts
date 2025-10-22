import "dotenv/config";
import sql from "mssql";

const dbConfig: sql.config = {
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  server: process.env.DB_SERVER || "",
  database: process.env.DB_DATABASE,
  options: {
    encrypt: false,
    trustServerCertificate: true,
  },
};

export const db = (async () => {
  try {
    const pool = await sql.connect(dbConfig);
    console.log("✅ Conectado ao banco de dados RM com sucesso!");
    return pool;
  } catch (error) {
    console.error("❌ Erro ao conectar ao banco:", error);
    throw error;
  }
})();
