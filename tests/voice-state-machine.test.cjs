const test = require("node:test");
const assert = require("node:assert/strict");
const { VoiceSessionStateMachine } = require("../dist-electron/VoiceSessionStateMachine.js");

test("system and microphone sessions are mutually exclusive", () => {
  const machine = new VoiceSessionStateMachine();
  const start = machine.toggle("system-audio", "system-1");
  assert.equal(start.action, "start");
  const conflict = machine.toggle("microphone", "mic-1");
  assert.equal(conflict.action, "conflict");
  assert.equal(conflict.message, "Stop System Audio recording first.");
  assert.equal(machine.snapshot().id, "system-1");
});

test("rapid repeated start requests produce one deferred stop", () => {
  const machine = new VoiceSessionStateMachine();
  assert.equal(machine.toggle("microphone", "mic-1").action, "start");
  assert.equal(machine.toggle("microphone", "ignored-id").action, "wait");
  assert.equal(machine.captureReady("mic-1"), "stop");
  assert.equal(machine.toggle("microphone", "ignored-id").action, "ignored");
});

test("a completed session can claim finalize, LLM, and history only once", () => {
  const machine = new VoiceSessionStateMachine();
  machine.toggle("system-audio", "system-1");
  assert.equal(machine.captureReady("system-1"), "record");
  assert.equal(machine.toggle("system-audio", "ignored-id").action, "stop");
  assert.equal(machine.claimFinalization("system-1"), true);
  assert.equal(machine.claimFinalization("system-1"), false);
  assert.equal(machine.claimLlm("system-1"), true);
  assert.equal(machine.claimLlm("system-1"), false);
  assert.equal(machine.claimHistory("system-1"), true);
  assert.equal(machine.claimHistory("system-1"), false);
  assert.equal(machine.finish("system-1"), true);
  assert.equal(machine.snapshot(), null);
});

test("stale sessions cannot enqueue audio or claim side effects", () => {
  const machine = new VoiceSessionStateMachine();
  machine.toggle("microphone", "mic-1");
  assert.equal(machine.acceptsAudio("other", "microphone"), false);
  assert.equal(machine.acceptsAudio("mic-1", "system-audio"), false);
  assert.equal(machine.claimFinalization("other"), false);
  assert.equal(machine.claimLlm("mic-1"), false);
  assert.equal(machine.claimHistory("mic-1"), false);
});
