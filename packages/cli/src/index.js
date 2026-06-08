'use strict';

module.exports = {
  checkSchema: require('./schema-checker').checkSchema,
  consistencyScore: require('./consistency-checker').consistencyScore,
};
