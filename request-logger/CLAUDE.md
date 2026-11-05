# request-logger

Tooling for the course, not lesson code. Read before changing it:

- Adding or changing a supported agent: [`ADDING_AN_AGENT.md`](ADDING_AN_AGENT.md).
- Verifying a change end to end, keyless, through the real proxy: [`e2e/README.md`](e2e/README.md).

The e2e harness drives the real code under test. When that code lacks a seam the harness needs, add the seam to the code itself, with a test, as its own commit. The code under test stays single-source: the harness only ever imports it.
