"use strict";

const path = require("node:path");

const Ajv2020 = require("ajv/dist/2020").default;
const addFormats = require("ajv-formats").default;
const schema = require("./generated/plugin-contract.schema.json");
const { assertPluginJsonValue } = require("./jsonBoundary.cjs");

function createDefinitionValidator(definitionName) {
  if (!schema.$defs?.[definitionName]) throw new Error(`Unknown plugin contract definition: ${definitionName}`);
  const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: true });
  addFormats(ajv);
  ajv.addSchema(schema);
  return ajv.compile({ $ref: `${schema.$id}#/$defs/${definitionName}` });
}

function formatValidationErrors(errors) {
  return (errors ?? [])
    .slice(0, 8)
    .map((error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`)
    .join("; ");
}

const rpcMessageValidator = createDefinitionValidator("RpcMessage");
const initializeResultValidator = createDefinitionValidator("RuntimeInitializeResult");
const streamFrameValidator = createDefinitionValidator("StreamFrame");

function assertContractValue(validator, value, label) {
  if (!validator(value)) {
    throw new TypeError(`${label} violates the plugin contract: ${formatValidationErrors(validator.errors)}`);
  }
  return value;
}

function assertRpcMessage(value) {
  assertPluginJsonValue(value);
  return assertContractValue(rpcMessageValidator, value, "RPC message");
}

function assertInitializeResult(value) {
  assertPluginJsonValue(value);
  return assertContractValue(initializeResultValidator, value, "Initialize result");
}

function assertStreamFrameSchema(value) {
  assertPluginJsonValue(value);
  return assertContractValue(streamFrameValidator, value, "Stream frame");
}

function resolveContractRuntimePath(...segments) {
  return path.join(__dirname, "..", "..", "node_modules", "@netcatty", "plugin-contract", "dist", ...segments);
}

module.exports = {
  assertInitializeResult,
  assertRpcMessage,
  assertStreamFrameSchema,
  createDefinitionValidator,
  formatValidationErrors,
  resolveContractRuntimePath,
};
