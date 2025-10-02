import {
  IntegreSQLClient,
  type IntegreSQLDatabaseConfig,
} from "@devoxa/integresql-client";
import { PrismaClient } from "@prisma/client";
import { execSync } from "child_process";
import { unsafeProjectId } from "../src/schemas/identifiers";

const integreSQL = new IntegreSQLClient({ url: "http://localhost:5000" });

let hash = "";

export async function setup() {
  console.log("TEST GLOBAL SETUP");
  hash = await integreSQL.hashFiles(["./prisma/schema.prisma"]);

  // Initialize the template database
  await integreSQL.initializeTemplate(hash, async (databaseConfig) => {
    const connectionUrl = integreSQL.databaseConfigToConnectionUrl(
      remapDBConfig(databaseConfig),
    );

    console.log("Migrating template database");
    // const prismaBin = path.join(process.cwd(), "./node_modules/.bin/prisma");
    const env = {
      DATABASE_URL: connectionUrl,
      PATH: process.env.PATH,
      NODE_ENV: process.env.NODE_ENV,
    };
    const output = execSync(
      `npx prisma db push --force-reset --skip-generate`,
      {
        env,
      },
    ).toString();

    console.log(output);
    console.log("Seeding template database");
    const db = new PrismaClient({
      datasourceUrl: connectionUrl,
    });
    //   await seed(db);

    // Close the database connection, without this the tests can hang
    await db.$disconnect();
  });
}
export async function buildTestDB() {
  const integreSQL = new IntegreSQLClient({ url: "http://localhost:5000" });
  const hash = await integreSQL.hashFiles(["./prisma/schema.prisma"]);
  const databaseConfig = await integreSQL.getTestDatabase(hash);
  console.log("testdb:", databaseConfig.database);
  const connectionUrl = integreSQL.databaseConfigToConnectionUrl(
    remapDBConfig(databaseConfig),
  );
  const db = new PrismaClient({
    datasourceUrl: connectionUrl,
  });
  // Automatically create a test project
  const testProject = await db.project.create({
    data: {
      name: "Test Project",
      description: "Auto-created project for testing",
    },
  });

  const teardown = async () => {
    await db.$disconnect();
  };
  return { db, projectId: unsafeProjectId(testProject.id), teardown };
}

const remapDBConfig = (
  databaseConfig: IntegreSQLDatabaseConfig,
): IntegreSQLDatabaseConfig => {
  databaseConfig.host = "localhost";
  if (process.env.DATABASE_URL?.includes("5555")) {
    databaseConfig.port = 5555;
  }
  return databaseConfig;
};
