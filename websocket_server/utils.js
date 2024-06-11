export const convertStringToArrayBuffer = (string) => new TextEncoder().encode(string).buffer
export const convertArrayBufferToString = (arrayBuffer) => new TextDecoder().decode(arrayBuffer)
export const parseBooleanFromEnv = (value) => value === 'true'
