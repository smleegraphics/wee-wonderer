// Where the scripts find the running app: the dev server on 5173, unless WW_URL names another
// (a second checkout's server, for one: `WW_URL=http://localhost:5174 node scripts/climbfuzz.mjs`).
// A dev server runs the code of the folder it was started in, so a check run against the wrong
// one tests someone else's code.
export const APP_URL = (process.env.WW_URL ?? 'http://localhost:5173').replace(/\/$/, '');
