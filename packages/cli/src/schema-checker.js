'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Check for breaking changes between two PASH schema files.
 * A breaking change is defined as:
 * - Removing a required field
 * - Changing the type of an existing field
 * - Removing a component entirely
 */
async function checkSchema(oldFilePath, newFilePath) {
  const oldData = JSON.parse(fs.readFileSync(path.resolve(oldFilePath), 'utf8'));
  const newData = JSON.parse(fs.readFileSync(path.resolve(newFilePath), 'utf8'));

  const breakingChanges = [];

  const oldComponents = oldData.components || {};
  const newComponents = newData.components || {};

  for (const [compName, oldComp] of Object.entries(oldComponents)) {
    const newComp = newComponents[compName];

    if (!newComp) {
      breakingChanges.push(`Component '${compName}' was removed entirely.`);
      continue;
    }

    const oldFields = oldComp.fields || {};
    const newFields = newComp.fields || {};
    const oldRequired = oldComp.required || [];
    const newRequired = newComp.required || [];

    for (const [fieldName, oldType] of Object.entries(oldFields)) {
      const newType = newFields[fieldName];
      
      if (newType === undefined) {
        breakingChanges.push(`Field '${fieldName}' was removed from component '${compName}'.`);
      } else if (oldType !== newType) {
        breakingChanges.push(`Field '${fieldName}' in component '${compName}' changed type from '${oldType}' to '${newType}'.`);
      }
    }

    // Check if a previously required field is no longer required
    for (const reqField of oldRequired) {
      if (!newRequired.includes(reqField)) {
        // This is technically a breaking change for clients relying on it being required
        // but we'll flag it as a warning or breaking change depending on strictness
        breakingChanges.push(`Field '${reqField}' in component '${compName}' is no longer marked as required.`);
      }
    }
  }

  return {
    hasBreakingChanges: breakingChanges.length > 0,
    breakingChanges,
  };
}

module.exports = { checkSchema };
