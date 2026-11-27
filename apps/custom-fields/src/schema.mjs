const maxInteger = 1_000_000_000;
const types = new Set(['text', 'integer', 'boolean', 'date', 'choice']);
const entityTypes = new Set(['school', 'student']);
const reserved = new Set([
  'id', 'tenant', 'tenant_id', 'school', 'school_id', 'student', 'student_id', 'entity_id',
  'org_unit', 'org_unit_id', 'identity_id', 'membership_id', 'legal_name', 'name',
  'first_name', 'last_name', 'full_name', 'birth', 'dob', 'ssn', 'nid', 'pin',
  'iban', 'cvv', 'otp', 'mfa', 'role', 'status', 'prototype', 'constructor',
]);
const sensitive = /password|passwd|secret|token|credential|nationalid|nationalcode|codemelli|kodemelli|socialsecurity|idcard|passport|phone|mobile|email|address|contact|firstname|lastname|fullname|legalname|birthdate|dateofbirth|biometric|fingerprint|health|medical|allerg|diagnos|disabilit|ethnic|religion|sexual|creditcard|bankaccount|financial|guardianidentity/u;
const executable = /[<>]|javascript\s*:|\bdata\s*:\s*text\/html|\b(?:eval|Function|import)\s*\(|\bfunction\s*(?:[A-Za-z_$][\w$]*\s*)?\(|=>/iu;

export class CustomFieldsError extends Error {}

export function fail(code = 'VALIDATION_FAILED') {
  throw new CustomFieldsError(code);
}

export function pickObject(value, allowed) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
    Object.keys(value).some(key => !allowed.includes(key))) fail();
}

export function typeOfEntity(value) {
  if (!entityTypes.has(value)) fail();
  return value;
}

export function fieldKey(value) {
  if (typeof value !== 'string' || value.length < 2 || value.length > 48 ||
    !/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(value) || reserved.has(value) ||
    sensitive.test(value.replaceAll('_', ''))) fail();
  return value;
}

export function revision(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value >= 2_147_483_647) fail();
  return value;
}

function plainText(value, maxLength, minLength = 1) {
  if (typeof value !== 'string' || value.length > maxLength * 2 ||
    /[\p{Cc}\p{Cs}]/u.test(value) || executable.test(value)) fail();
  const size = [...value].length;
  if (size < minLength || size > maxLength || (minLength > 0 && !value.trim())) fail();
  return value;
}

function boundedInteger(value) {
  if (!Number.isSafeInteger(value) || Math.abs(value) > maxInteger) fail();
  return value;
}

function boundedDate(value) {
  if (typeof value !== 'string' || !/^(?:19\d{2}|20\d{2}|21\d{2}|2200)-\d\d-\d\d$/.test(value) ||
      !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) fail();
  return value;
}

function constrained(type, constraints) {
  switch (type) {
    case 'text': {
      pickObject(constraints, ['maxLength']);
      const { maxLength = 160 } = constraints;
      if (!Number.isInteger(maxLength) || maxLength < 1 || maxLength > 500) fail();
      return { maxLength };
    }
    case 'integer': {
      pickObject(constraints, ['minimum', 'maximum']);
      const minimum = boundedInteger(constraints.minimum === undefined ? -maxInteger : constraints.minimum);
      const maximum = boundedInteger(constraints.maximum === undefined ? maxInteger : constraints.maximum);
      if (minimum > maximum) fail();
      return { minimum, maximum };
    }
    case 'date': {
      pickObject(constraints, ['minDate', 'maxDate']);
      const minDate = boundedDate(constraints.minDate === undefined ? '1900-01-01' : constraints.minDate);
      const maxDate = boundedDate(constraints.maxDate === undefined ? '2200-12-31' : constraints.maxDate);
      if (minDate > maxDate) fail();
      return { minDate, maxDate };
    }
    case 'choice': {
      pickObject(constraints, ['options']);
      if (!Array.isArray(constraints.options) || constraints.options.length < 1 || constraints.options.length > 32) fail();
      const options = constraints.options.map(option => plainText(option, 80));
      if (new Set(options).size !== options.length) fail();
      return { options };
    }
    case 'boolean':
      pickObject(constraints, []);
      return {};
    default:
      fail();
  }
}

export function readDefinition(body) {
  pickObject(body, ['entityType', 'key', 'label', 'type', 'constraints', 'required', 'expectedVersion']);
  const { type, required = false, constraints = {}, expectedVersion = 0 } = body;
  if (!types.has(type) || typeof required !== 'boolean') fail();
  return {
    entityType: typeOfEntity(body.entityType),
    key: fieldKey(body.key),
    label: plainText(body.label, 100),
    type, constraints: constrained(type, constraints),
    required, expectedVersion: revision(expectedVersion),
  };
}

export function validateValue(type, constraints, required, value) {
  if (value === null && !required) return null;
  switch (type) {
    case 'text': return plainText(value, constraints.maxLength, required ? 1 : 0);
    case 'integer':
      if (boundedInteger(value) < constraints.minimum || value > constraints.maximum) fail();
      return value;
    case 'date':
      if (boundedDate(value) < constraints.minDate || value > constraints.maxDate) fail();
      return value;
    case 'choice':
      if (!constraints.options.includes(value)) fail();
      return value;
    case 'boolean':
      if (typeof value !== 'boolean') fail();
      return value;
    default: fail();
  }
}
