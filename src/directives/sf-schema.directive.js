import angular from 'angular';

/**
FIXME: real documentation
<form sf-form="form"  sf-schema="schema" sf-decorator="foobar"></form>
*/
/**
 * [description]
 *
 * @param  {[type]} $compile             [description]
 * @param  {[type]} $http                [description]
 * @param  {[type]} $templateCache       [description]
 * @param  {[type]} $q                   [description]
 * @param  {[type]} schemaForm           [description]
 * @param  {[type]} schemaFormDecorators [description]
 * @param  {[type]} sfSelect             [description]
 * @param  {[type]} sfBuilder            [description]
 *
 * @return {[type]}                      [description]
 */
export default function($compile, $http, $templateCache, $q, schemaForm, schemaFormDecorators,
sfSelect, sfBuilder) {
  return {
    scope: {
      schema: '=sfSchema',
      initialForm: '=sfForm',
      model: '=sfModel',
      options: '=sfOptions',
    },
    controller: [ '$scope', function($scope) {
      this.$onInit = function() {
        this.evalInParentScope = function(expr, locals) {
          return $scope.$parent.$eval(expr, locals);
        };

        // Set up form lookup map
        let that = this;
        $scope.lookup = function(lookup) {
          if (lookup) {
            that.lookup = lookup;
          }
          return that.lookup;
        };
      };

      // Prior to v1.5, we need to call `$onInit()` manually.
      // (Bindings will always be pre-assigned in these versions.)
      if (angular.version.major === 1 && angular.version.minor < 5) {
        this.$onInit();
      }
    } ],
    replace: false,
    restrict: 'A',
    transclude: true,
    require: '?form',
    link: function(scope, element, attrs, formCtrl, transclude) {
      // expose form controller on scope so that we don't force authors to use name on form
      scope.formCtrl = formCtrl;

      // We'd like to handle existing markup,
      // besides using it in our template we also
      // check for ng-model and add that to an ignore list
      // i.e. even if form has a definition for it or form is ["*"]
      // we don't generate it.
      let ignore = {};
      transclude(scope, function(clone) {
        clone.addClass('schema-form-ignore');
        element.prepend(clone);

        if (element[0].querySelectorAll) {
          let models = element[0].querySelectorAll('[ng-model]');
          if (models) {
            for (let i = 0; i < models.length; i++) {
              let key = models[i].getAttribute('ng-model');
              // skip first part before .
              ignore[key.substring(key.indexOf('.') + 1)] = true;
            }
          }
        }
      });

      let lastDigest = {};
      let childScope;

      // Common renderer function, can either be triggered by a watch or by an event.
      scope.resolveReferences = function (schema, form) {
        schemaForm
          .jsonref(schema)
          .then((resolved) => {
            scope.render(resolved, form);
          })
          .catch((err) => {
            new Error(err);
          });
      };

      scope.render = function(schema, form) {
        let asyncTemplates = [];
        let merged = schemaForm.merge(schema, form, undefined, ignore, scope.options, undefined, asyncTemplates);

        if (asyncTemplates.length > 0) {
          // Pre load all async templates and put them on the form for the builder to use.
          $q.all(
            asyncTemplates
              .map(function(form) {
                return $http.get(form.templateUrl, { cache: $templateCache })
                  .then(function(res) {
                    form.template = res.data;
                  });
              })
          )
          .then(function() {
            scope.internalRender(schema, form, merged);
          });
        }
        else {
          scope.internalRender(schema, form, merged);
        };
      };

      scope.internalRender = function(schema, form, merged) {
        // Create a new form and destroy the old one.
        // Not doing keeps old form elements hanging around after
        // they have been removed from the DOM
        // https:// github.com/Textalk/angular-schema-form/issues/200
        if (childScope) {
          // Destroy strategy should not be acted upon
          scope.externalDestructionInProgress = true;
          childScope.$destroy();
          scope.externalDestructionInProgress = false;
        };
        childScope = scope.$new();

        // make the form available to decorators
        childScope.schemaForm = { form: merged, schema: schema };

        // clean all but pre existing html.
        Array.prototype.forEach.call(element.children(), function(child) {
          let jchild = angular.element(child);
          if (false === jchild.hasClass('schema-form-ignore')) {
            jchild.remove();
          };
        });

        // Find all slots.
        let slots = {};
        let slotsFound = element[0].querySelectorAll('*[sf-insert-field]');

        for (let i = 0; i < slotsFound.length; i++) {
          slots[slotsFound[i].getAttribute('sf-insert-field')] = slotsFound[i];
        }

        // if sfUseDecorator is undefined the default decorator is used.
        let decorator = schemaFormDecorators.decorator(attrs.sfUseDecorator);
        // Use the builder to build it and append the result
        let lookup = Object.create(null);
        scope.lookup(lookup); // give the new lookup to the controller.
        element[0].appendChild(sfBuilder.build(merged, decorator, slots, lookup));

        // We need to know if we're in the first digest looping
        // I.e. just rendered the form so we know not to validate
        // empty fields.
        childScope.firstDigest = true;
        // We use a ordinary timeout since we don't need a digest after this.
        setTimeout(function() {
          childScope.firstDigest = false;
          scope.$apply();
        }, 0);

        // compile only children
        $compile(element.children())(childScope);

        // ok, now that that is done let's set any defaults
        if (!scope.options || scope.options.setSchemaDefaults !== false) {
            // PROBLEM: to reflect visibility rules in model, need to mark all elements as visible (true / false)
            // ASSUMPTION: not every subelement has a direct condition assigned,
            // it might be inheriting from parent or grandparent
            // SOLUTION: scan all nodes, mark visible or not based on condition parsing
            // and
            // PROBLEM 2: condition might rely on a default value from model that was not set at this point
            // ASSUMPTION: doing extra rounds through form and schema is fast enough
            // SOLUTION:
            //  1. create all defaults once (without checking form visibility)
            //  2. mark visibility based on that
            //  3. go through model again and now remove all values that should not be there (based on form rules)

            var start = new Date();
            // console.log(start, 'before 1. setDefaults');
            setDefaults(schema, form, false);
            // console.log('scope before', scope.model);
            // console.log(new Date()-start, 'before markVisibility');
            markVisibility(form);
            // console.log(new Date()-start, 'before 2. setDefaults');
            setDefaults(schema, form, true);
            console.log(new Date()-start, 'after 2. setDefaults');
        }

        scope.$emit('sf-render-finished', element);
      };

      /**
       * go through entire form and set all default values based on schema definition
       * (if onlyVisible is set to true,
       *  only set values where any referencing form.key element has its visibility 'condition' evaluating to true)
       * @param schema
       * @param form
       * @param onlyVisible
       */
      function setDefaults(schema, form, onlyVisible) {

          schemaForm.traverseSchema(schema, function(prop, path) {

              // look only at schema fields that have a 'default' prop
              if (angular.isDefined(prop['default'])) {

                  // let val = sfSelect(path, scope.model);
                  // if no value is currently set in the models field
                  if (onlyVisible) {
                      var fieldIsVisible = true;
                      // find all fields in form that have key === path (might be more than 1)
                      var fields = [];

                      // for each of them, check previously set "visible" element
                      // if the form is currently visible (meaning evaluating the "condition" prop resulted in true

                      traverseFlat(form, function (item) {
                          if (JSON.stringify(item.key) === JSON.stringify(path)) {
                              fields.push(item);
                          }
                      });

                      if (fields.length > 0) {
                          // mark as false (invisible) if at least one of the fields is invisible
                          fieldIsVisible = _.reduce(fields, function (memo, now) {
                              return memo && now.visibl;
                          }, true);
                      }

                      // delete from model if it's not visible in form currently
                      if (fieldIsVisible === false) {
                          deepDelete(scope.model, path);
                          return;
                      }
                  }

                  // Set to default value
                  let defVal = prop['default'];
                  if (angular.isObject(defVal)) defVal = angular.copy(defVal);
                  sfSelect(path, scope.model, defVal);
              }
          });

          if (onlyVisible) {
              // TODO: shake tree (remove all subelements that are empty objects (such as Bankverbindung : {})
              shakeTree(scope.model);
          }
      }

      /**
       * remove all sub-nodes that are just empty objects
       * @param obj
       */
      function shakeTree(obj) {
          if (obj === null || obj === undefined) {
              return;
          }
          Object.keys(obj).forEach(function(key) {
              if (obj[key] && typeof obj[key] === 'object') {
                  // console.log('now at', key, obj[key]);
                  // if it's empty, delete
                  if (Object.keys(obj[key]).length === 0) {
                     // console.log('ready to delete', key, obj[key]);
                      delete obj[key];
                  }
                  else {
                      shakeTree(obj[key]);
                  }
              }
          });
      }

      /**
       * traverse through an object and remove a specified grand-child node
       * based on https://stackoverflow.com/a/37987997
       * @param obj
       * @param path_to_key
       * @returns {*}
       */
      function deepDelete(obj, path_to_key) {
        if (path_to_key.length === 1) {
            delete obj[path_to_key[0]];
            return true;
        }
        else {
            if (obj[path_to_key[0]])
                return deepDelete(obj[path_to_key[0]], path_to_key.slice(1));
            else
                return false;
        }
      }

      /**
       * evaluate angular expressions (usually 'condition' field of a form item)
       * (this is normally done inside an ng-template but we need the results before actual rendering
       * @param condition
       * @returns {boolean}
       */
      function evalCondition(condition) {
          var visible = true;
          if (condition !== undefined && condition !== '') {
              // parse and run on actual scope.model
              visible = scope.$eval(condition);
          }
          // console.log('now at condition', condition, visible);
          return visible;
      }

      /**
       * traverse nested elements (like traverseForm)
       * @param tree
       * @param parent
       * @param callback
       */
      function traverseIn(tree, parent, callback) {
          callback(tree, parent);

          if (_.isArray(tree)) {
              // Main form is just a single array, so make it behave like subelements
              tree.items = tree;
          }
          if (tree.hasOwnProperty('items')) {
              tree.items.forEach(function(subtree) {
                  traverseIn(subtree, tree, callback);
              });
          }
      }

      /**
      * traverse tree, but in a single list, so we can handle setTimeout better
      * and avoid stack overflows
      * based on https://stackoverflow.com/a/49523815
      */
      function traverseFlat(queue, callback) {
        var current = queue.shift();
        if (current === undefined) {
          return;
        }

        // TODO: actual action goes here
        callback(current);
        //console.log(current, 'action jackson');

        if (current.items) {
          current.items.forEach(node => {
            queue.push(node)
          })
        }
        setTimeout(function() {
          traverseFlat(queue, callback);
        }, 25); // based on https://www.nczonline.net/blog/2009/08/11/timed-array-processing-in-javascript/
      }

      /**
       * traverse entire form and add a new property "visibl"
       * to directly mark it with results of parsing a "condition" angular expression
       * @param form
       */
      function markVisibility(form) {
          traverseIn(form, null, function(item, parent) {
              if (item.hasOwnProperty('condition') === false) {
                  if (parent !== null) {
                      item.visibl = parent.visibl;
                  }
                  else {
                      item.visibl = true;
                  }
              }
              else if (item.hasOwnProperty('condition')) {
                  item.visibl = evalCondition(item.condition);
              }
              else {
                  item.visibl = false;
              }
          });
      }
      let defaultForm = [ '*' ];

      // Since we are dependant on up to three
      // attributes we'll do a common watch
      scope.$watch(function() {
        let schema = scope.schema;
        let form = scope.initialForm || defaultForm;

        // The check for schema.type is to ensure that schema is not {}
        if (form && schema && schema.type && // schema.properties &&
            (lastDigest.form !== form || lastDigest.schema !== schema)) {
          if((!schema.properties || Object.keys(schema.properties).length === 0) &&
              (form.indexOf('*') || form.indexOf('...'))) {
            // form.unshift({"key":"submit", "type": "hidden"});
          };

          lastDigest.schema = schema;
          lastDigest.form = form;

          scope.resolveReferences(schema, form);
        }
      });

      // We also listen to the event schemaFormRedraw so you can manually trigger a change if
      // part of the form or schema is chnaged without it being a new instance.
      scope.$on('schemaFormRedraw', function() {
        let schema = scope.schema;
        let form = scope.initialForm ? angular.copy(scope.initialForm) : [ '*' ];
        if (schema) {
          scope.resolveReferences(schema, form);
        }
      });

      scope.$on('$destroy', function() {
        // Each field listens to the $destroy event so that it can remove any value
        // from the model if that field is removed from the form. This is the default
        // destroy strategy. But if the entire form (or at least the part we're on)
        // gets removed, like when routing away to another page, then we definetly want to
        // keep the model intact. So therefore we set a flag to tell the others it's time to just
        // let it be.
        scope.externalDestructionInProgress = true;
      });

      /**
       * Evaluate an expression, i.e. scope.$eval
       * but do it in parent scope
       *
       * @param {String} expression
       * @param {Object} locals (optional)
       * @return {Any} the result of the expression
       */
      scope.evalExpr = function(expression, locals) {
        return scope.$parent.$eval(expression, locals);
      };
    },
  };
}
