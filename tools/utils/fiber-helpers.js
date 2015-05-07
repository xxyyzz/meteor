var _ = require("underscore");
var Fiber = require("fibers");

exports.parallelEach = function (collection, callback, context) {
  var errors = [];
  context = context || null;

  var results = Promise.all(_.map(collection, function (...args) {
    return new Promise(function (resolve, reject) {
      Fiber(function () {
        try {
          resolve(callback.apply(context, args));
        } catch (err) {
          reject(err);
        }
      }).run();
    }).catch(function (error) {
      // Collect the errors but do not propagate them so that we can
      // re-throw the first error after all iterations have completed.
      errors.push(error);
    });
  })).await();

  if (errors.length > 0) {
    throw errors[0];
  }

  return results;
};

function disallowedYield() {
  throw new Error("Can't call yield in a noYieldsAllowed block!");
}
// Allow testing Fiber.yield.disallowed.
disallowedYield.disallowed = true;

exports.noYieldsAllowed = function (f, context) {
  var savedYield = Fiber.yield;
  Fiber.yield = disallowedYield;
  try {
    return f.call(context || null);
  } finally {
    Fiber.yield = savedYield;
  }
};

// Borrowed from packages/meteor/dynamics_nodejs.js
// Used by buildmessage

exports.nodeCodeMustBeInFiber = function () {
  if (!Fiber.current) {
    throw new Error("Meteor code must always run within a Fiber. " +
                    "Try wrapping callbacks that you pass to non-Meteor " +
                    "libraries with Meteor.bindEnvironment.");
  }
};

var nextSlot = 0;
exports.EnvironmentVariable = function (defaultValue) {
  var self = this;
  self.slot = 'slot' + nextSlot++;
  self.defaultValue = defaultValue;
};

_.extend(exports.EnvironmentVariable.prototype, {
  get: function () {
    var self = this;
    exports.nodeCodeMustBeInFiber();

    if (!Fiber.current._meteorDynamics) {
      return self.defaultValue;
    }
    if (!_.has(Fiber.current._meteorDynamics, self.slot)) {
      return self.defaultValue;
    }
    return Fiber.current._meteorDynamics[self.slot];
  },

  withValue: function (value, func) {
    var self = this;
    exports.nodeCodeMustBeInFiber();

    if (!Fiber.current._meteorDynamics) {
      Fiber.current._meteorDynamics = {};
    }
    var currentValues = Fiber.current._meteorDynamics;

    var saved = _.has(currentValues, self.slot)
          ? currentValues[self.slot] : self.defaultValue;
    currentValues[self.slot] = value;

    try {
      return func();
    } finally {
      currentValues[self.slot] = saved;
    }
  }
});

// This is like Meteor.bindEnvironment.
// Experimentally, we are NOT including onException or _this in this version.
exports.bindEnvironment = function (func) {
  exports.nodeCodeMustBeInFiber();

  var boundValues = _.clone(Fiber.current._meteorDynamics || {});

  return function (...args) {
    var self = this;

    var runWithEnvironment = function () {
      var savedValues = Fiber.current._meteorDynamics;
      try {
        // Need to clone boundValues in case two fibers invoke this
        // function at the same time
        Fiber.current._meteorDynamics = _.clone(boundValues);
        return func.apply(self, args);
      } finally {
        Fiber.current._meteorDynamics = savedValues;
      }
    };

    if (Fiber.current) {
      return runWithEnvironment();
    }
    Fiber(runWithEnvironment).run();
  };
};

// An alternative to bindEnvironment for the rare case where you
// want the callback you're passing to some Node function to start
// a new fiber but *NOT* to inherit the current environment.
// Eg, if you are trying to do the equivalent of start a background
// thread.
exports.inBareFiber = function (func) {
  return function (...args) {
    var self = this;
    new Fiber(function () {
      func.apply(self, args);
    }).run();
  };
};

// Returns a Promise that supports .resolve(result) and .reject(error).
exports.makeFulfillablePromise = function () {
  var resolve, reject;
  var promise = new Promise(function (res, rej) {
    resolve = res;
    reject = rej;
  });
  promise.resolve = resolve;
  promise.reject = reject;
  return promise;
};
