import { describe, it, expect } from 'vitest';
import {
  upc,
  ndb,
  nutrient_unit_name,
  dataTypeEnum,
  branded_food_serving_size_unit,
} from './schemas';

describe('UPC validation', () => {
  it('should accept valid 12-digit UPC', () => {
    expect(() => upc.parse('123456789012')).not.toThrow();
  });

  it('should accept valid 14-digit UPC', () => {
    expect(() => upc.parse('12345678901234')).not.toThrow();
  });

  it('should reject UPC shorter than 12 digits', () => {
    expect(() => upc.parse('12345678901')).toThrow();
  });

  it('should reject UPC longer than 14 digits', () => {
    expect(() => upc.parse('123456789012345')).toThrow();
  });

  it('should reject empty UPC', () => {
    expect(() => upc.parse('')).toThrow();
  });
});

describe('NDB number validation', () => {
  it('should accept valid NDB number within range', () => {
    expect(() => ndb.parse(12345)).not.toThrow();
    expect(() => ndb.parse(1000)).not.toThrow();
    expect(() => ndb.parse(99999)).not.toThrow();
  });

  it('should reject NDB number below minimum', () => {
    expect(() => ndb.parse(999)).toThrow();
  });

  it('should reject NDB number above maximum', () => {
    expect(() => ndb.parse(100000)).toThrow();
  });

  it('should reject negative NDB numbers', () => {
    expect(() => ndb.parse(-1)).toThrow();
  });
});

describe('Nutrient unit name enum', () => {
  it('should accept valid nutrient unit names', () => {
    expect(() => nutrient_unit_name.parse('MG_ATE')).not.toThrow();
    expect(() => nutrient_unit_name.parse('KCAL')).not.toThrow();
    expect(() => nutrient_unit_name.parse('G')).not.toThrow();
  });

  it('should reject invalid nutrient unit names', () => {
    expect(() => nutrient_unit_name.parse('INVALID')).toThrow();
    expect(() => nutrient_unit_name.parse('')).toThrow();
  });

  it('should have all expected nutrient unit values', () => {
    const expected = [
      'MG_ATE',
      'kJ',
      'MCG_RE',
      'KCAL',
      'SP_GR',
      'PH',
      'UG',
      'MG_GAE',
      'UMOL_TE',
      'G',
      'MG',
      'IU',
    ];

    for (const unit of expected) {
      expect(() => nutrient_unit_name.parse(unit)).not.toThrow();
    }
  });
});

describe('Data type enum', () => {
  it('should accept valid data types', () => {
    expect(() => dataTypeEnum.parse('branded_food')).not.toThrow();
    expect(() => dataTypeEnum.parse('foundation_food')).not.toThrow();
    expect(() => dataTypeEnum.parse('sr_legacy_food')).not.toThrow();
  });

  it('should reject invalid data types', () => {
    expect(() => dataTypeEnum.parse('invalid_type')).toThrow();
    expect(() => dataTypeEnum.parse('')).toThrow();
  });

  it('should have all expected data type values', () => {
    const expected = [
      'agricultural_acquisition',
      'branded_food',
      'experimental_food',
      'foundation_food',
      'market_acquisition',
      'sample_food',
      'sr_legacy_food',
      'sub_sample_food',
      'survey_fndds_food',
    ];

    for (const dataType of expected) {
      expect(() => dataTypeEnum.parse(dataType)).not.toThrow();
    }
  });
});

describe('Branded food serving size unit enum', () => {
  it('should accept valid serving size units', () => {
    expect(() => branded_food_serving_size_unit.parse('g')).not.toThrow();
    expect(() => branded_food_serving_size_unit.parse('ml')).not.toThrow();
    expect(() => branded_food_serving_size_unit.parse('GM')).not.toThrow();
  });

  it('should reject invalid serving size units', () => {
    expect(() => branded_food_serving_size_unit.parse('kg')).toThrow();
    expect(() => branded_food_serving_size_unit.parse('')).toThrow();
  });

  it('should have all expected serving size unit values', () => {
    const expected = ['g', 'GM', 'GRM', 'IU', 'MC', 'MG', 'ml', 'MLT'];

    for (const unit of expected) {
      expect(() => branded_food_serving_size_unit.parse(unit)).not.toThrow();
    }
  });
});
