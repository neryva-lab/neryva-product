/**
 * Public entry point for @neryva/mcp-contract — re-exports the generated
 * protobuf types and Connect service definitions. Consumers (engine, studio)
 * import everything from here; the generated files under gen/ts are build
 * artifacts and are never edited by hand.
 */
export * from '../gen/ts/neryva/mcp/common/v1/common_pb.js';
export * from '../gen/ts/neryva/mcp/identity/v1/identity_pb.js';
export * from '../gen/ts/neryva/mcp/run/v1/run_pb.js';
export * from '../gen/ts/neryva/mcp/event/v1/event_pb.js';
export * from '../gen/ts/neryva/mcp/context/v1/context_pb.js';
export * from '../gen/ts/neryva/mcp/tool/v1/tool_pb.js';
export * from '../gen/ts/neryva/mcp/approval/v1/approval_pb.js';
export * from '../gen/ts/neryva/mcp/checkpoint/v1/checkpoint_pb.js';
export * from '../gen/ts/neryva/mcp/runtime/v1/runtime_pb.js';
// Services are declared in the *_connect files; named re-exports shadow the
// star-export collisions with the *_pb re-exports.
