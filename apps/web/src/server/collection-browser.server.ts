import {
  collectionCreateInput,
  collectionDetailInput,
  collectionDetailOut,
  collectionMatrixInput,
  collectionMatrixOut,
  collectionSummaryOut,
  collectionTagSetInput,
  collectionTagSetOut,
} from "@cubby/schemas/collection";
import { z } from "zod";
import {
  runStartOperation,
  type StartOperationRequest,
} from "~/server/start-operation.server";
import {
  createCollection as createCollectionWorkflow,
  listCollectionSummaries,
  readCollectionDetail,
  readCollectionMatrix,
  setCollectionMembership as setCollectionMembershipWorkflow,
} from "~/server/workflows/collection";

export const listCollectionsForBrowser = async (options: {
  request: StartOperationRequest;
}) =>
  await runStartOperation({
    operation: "collection.list",
    type: "query",
    input: undefined,
    inputSchema: z.undefined(),
    outputSchema: z.array(collectionSummaryOut),
    request: options.request,
    readPolicy: "strong",
    run: listCollectionSummaries,
  });

export const getCollectionDetailForBrowser = async (options: {
  data: z.input<typeof collectionDetailInput>;
  request: StartOperationRequest;
}) =>
  await runStartOperation({
    operation: "collection.detail",
    type: "query",
    input: options.data,
    inputSchema: collectionDetailInput,
    outputSchema: collectionDetailOut,
    request: options.request,
    readPolicy: "strong",
    run: readCollectionDetail,
  });

export const getCollectionMatrixForBrowser = async (options: {
  data: z.input<typeof collectionMatrixInput>;
  request: StartOperationRequest;
}) =>
  await runStartOperation({
    operation: "collection.matrix",
    type: "query",
    input: options.data,
    inputSchema: collectionMatrixInput,
    outputSchema: collectionMatrixOut,
    request: options.request,
    readPolicy: "strong",
    run: readCollectionMatrix,
  });

export const setCollectionMembershipForBrowser = async (options: {
  data: z.input<typeof collectionTagSetInput>;
  request: StartOperationRequest;
}) =>
  await runStartOperation({
    operation: "collection.set",
    type: "mutation",
    input: options.data,
    inputSchema: collectionTagSetInput,
    outputSchema: collectionTagSetOut,
    request: options.request,
    run: setCollectionMembershipWorkflow,
  });

export const createCollectionForBrowser = async (options: {
  data: z.input<typeof collectionCreateInput>;
  request: StartOperationRequest;
}) =>
  await runStartOperation({
    operation: "collection.create",
    type: "mutation",
    input: options.data,
    inputSchema: collectionCreateInput,
    outputSchema: collectionSummaryOut,
    request: options.request,
    run: createCollectionWorkflow,
  });
