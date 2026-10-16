/** Opaque request/transaction identity; concrete clients stay at the repository boundary. */
export class Database {
  declare private readonly databaseIdentity: void;
}
