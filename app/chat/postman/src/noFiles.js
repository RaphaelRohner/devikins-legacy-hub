// Klever's crypto library contains a helper that reads key files from a
// disk (only on a computer). The postman never uses it and has no disk;
// this stand-in makes sure it can't do anything here.
export function readFile() {
  throw new Error('The postman has no files.');
}
export default { readFile };
