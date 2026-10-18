// One job at a time, in the order asked: renders are heavy, and HeyGen and ElevenLabs calls are paid.
// ahead(id): how many are before it, the running one included (-1 when it isn't waiting).
export function serialQueue() {
  let tail = Promise.resolve();
  const line = [];
  return {
    add(id, work) {
      line.push(id);
      tail = tail.then(work).catch((e) => console.error(`[${id}]`, e)).finally(() => line.splice(line.indexOf(id), 1));
    },
    ahead: (id) => line.indexOf(id),
  };
}
