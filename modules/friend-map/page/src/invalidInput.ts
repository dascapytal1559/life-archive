// What is asked for is wrong (a query that does not parse, a setting out of range): a 400 from the server, and the
// same error where the page works it out itself (the query language run in the page, src/pageQuery.ts).

export class InvalidInputError extends Error {}
