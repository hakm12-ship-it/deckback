// The validator's helper lives with the core tests, which lower the Scene and validate what they write too; the ooxml
// tests reach the core test helpers already (tsconfig.test.json references them), and the other way round would be a cycle.
export { validatePptx, type ValidatorError } from '../../../core/test/helpers/validate';
