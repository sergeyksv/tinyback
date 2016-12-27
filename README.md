# TinyBack(bone) minimalistic modularized application with dependencies

Tinyback is lightweight application container build on top of Express.JS. Primary
challenges that it is supposed to solve are following:
* Handle initialization of application that consists from multiple modules with dependencies
* Enforce simple yet effective code / api patterns for modules that help to:
  * provide out of the box effective RESTAPI for any module
	* reuse modules across projects
	* launch modules in separate processes to increase app throughput and responsibility
	* effectively share Express.JS application between modules
* Be an effective companion for Tiny(back)Bone dual rendering front-end library
* Provide standard modules for basic demands (db access, permission control, data validation)

For example application please please see:
* https://github.com/sergeyksv/tinyapp-bootstrap
* https://github.com/sergeyksv/tinelic

## Application bootstrapping

TinyBack is responsible for initialization of application. Essentially for loading all modules according to dependencies and parameters and bringing back fully configured express app.

Application is initialize based on configuration object which in first order should list all modules that application is consists from:
```
var cfg = {
	modules: [
		{name: "prefixify", object: tinyback.prefixify()},
		{name: "tson", object: tinyback.tson()},
		{name: "validate", object: tinyback.validate()},
		{name: "mongo", object: tinyback.mongodb()},
		{name: "cache", object: tinyback.mongocache()},
		{name: "web", require: "./modules/web"}
	],
	defaults:{
		module:{
			reqs:{
				router:true,
				globalUse:true
			}
		}
	},
	config:{
	}
};
```
Configuration object include following sections:
* modules
List modules that need to be initialized for application
* defaults
This section is created to provide backward compatibility behaviors. Ideally it should be empty which
will means that application is adopted to modern version
* config
This section include specific application configuration.

Later application can be initialized as:
```
tinyback.createApp(cfg, safe.sure(cb, function (app) {
	var httpServer = http.createServer(app.express);
	httpServer.listen(80);
```

## Modules and parameters
Module is more or less independent peace of code that is supposed to provide certain functionality through API. Module can receive its own Express router that can be used to expose publicly any Web functionality. Module can declare dependency from other modules

### Initialization parameters
* name
Name is used as module handle (reference) and also used as a prefix for Express router. For instance if we declare module "web" it will be available on something like http://localhost/web address.
* object
Essentially already initialized module is object
* require
TinyBack can load module using an URI which is compatible with normal NodeJS `require(URI)` pattern.
* target
TinyBack can support application that spawns across multiple processes. This can be useful to increase application redundancy, responsibility and more effective use CPU resources. Target define virtual container (process) for modules. There is two predefined containers: `root` and `local`. `local` target denotes module which instances is loaded into every process. `root` target denotes main application process.

### Module object
* deps[name1, name2, ...]
List of module dependencies. Module expect that application do have listed modules and they are initialized prior to this module initialization
* reqs[...]
Array of supported module requirements
  * router=true|false, default false
  Module can declare if it want to have express route allocated to it or not
	* globalUse=true|false, default false
	Declares if module expect some legacy express.use modules to be called for router or not. New behavior for module is to apply
	its own express use statements as required and do not rely on global ones.
* init
The only single module function that is used to initialization of module

### Module initialization function
Module initialization is receiving context object and supposed to return initialized module object. Initialized module should return object with one property called api which contain object with functions that module want expose to outside.

#### Context object
* target
Container name that this modules is configured to run in. Module can adopt to one of known container types
* api
Placeholder object that will hold api interfaces of all loaded objects. Module can expect that api object already have all dependent object that it declares and it can use their functions
* locals
Placeholder object that is shared between all modules from the same container.
* cfg
Configuration object for application customization
* app
Instance of currently initialized TinyBack application
* router
When modules declares requirement for Express route this property will have initiated Express router.

## Buildin modules

### tson
As it well known JSON support only trivial types and has some problems to pass more "complex" types like Date. TSON module tried to address this task by doing encoding and decoding object into vanilla JSON but keeping type information. By default it support only Date (which is not that small), but can be extended as required. Module has following api:
* encode(obj, copy)
Encode JS object into JSON friendly object. Essentially by default it detect Date object and replaced them to {$tson:"date":v:Date.valueOf()}. Optionally it does copy of object.
* decode(obj,copy)
Does opposite transformation - converts JSON friendly object into JS object

TSON has pluggable body that can work both on server side and inside browser.

### restapi
This module is supposed to provide generic way to expose application modules functionality via REST api. Standard scheme is to expose modules using route `/restapi/:token/:module/:function`. Module has following specifics:
* restapi expect that every function that it will serve will have `(token, params, cb)` signature.
* restapi accept both POST and GET calls. Default behavior uses req.query or req.params directly as `params`
* when query of form params include special parameter `_t_jsonq` restapi parses it from JSON and passes as `params`
* when paremeters have `_t_son` variable module can do tson (types json) transformation according to _t_son value (which can be `in`, `out` or `both`). This is usefull to keep types for non standard JSON types (like date).
* when paramaters include `_t_age` variable module sets cache headers to according to value (like `1m`, `4h` etc). This can be used for controlling client side caching
* module has a mapping for err.subject to certian HTTP erro codes. Specifically:
  * "Unauthorized":401
  * "Access forbidden":403
  * "Invalid Data":422
  * "Not Found":404
* module can be configured to whitelist or black list certain application modules or specific functions. For security purposes it is required to white list modules that are exposed through api the reason is that not all module do check permissions and in general are allowed for external callbacks for backward compatibility it is ok to make empty restapi section with no restapi.modules defined.
    ```
    config:{
        restapi: {
    		 modules:{"statistics":1,"users":1,"web":10, // enable/disable entire modules
    			 "obac":{blacklist:{"register":1}}, // black list one function
    			 "email":{whitelist:{"getSendingStatuses":1}}} // whitelist one function
    	    }
        }
    }
    ```		

### prefixify
This is helper module to deal with keeping/sticking of JS object attribute types base don prefixes. This is companion module for MongoDB which is very flexible but in the same time very dependent of variable types. By default followig prefixes as supported:
* `_i_` - integer
* `_s_` - string
* `_id` - BSON.ObjectId
* `_f_` - float/double
* `_t_` - tempoary variable (gets deleted)
* `_dt` - Date()
* `_b_` - boolean

Module exposes following API:

* data/datafix(object, opts{strict:true|false})
Function recursively scan object and ensures (check and attempt to transform) that variable types are correspond to prefixes. If variable not matches it is gets deleted or if opts.strict=true is specified exception is raised.
* query/queryfix(object, opts{})
Does the same as datafix with assumption that passed object is MongoDB query
* sort
Does the same as datafix with assumption that passed object is MongoDB sort expression
* register(prefix, transform)
Register new prefix and transformation functions. For instance here is _b_ transformation function:
    ```
    function (pr) {
    	if (pr === true || pr === 1 || pr === "true" || pr === "1")
    		return true;
    	if (pr === false || pr === 0 || pr === "false" || pr === "0" || pr === null || pr === "null")
    		return false;
    }
    ```
PREFIXIFY has pluggable body that can work both on server side and inside browser.

### mongodb
This is minimal module that works as a helper with initiating connection with mongodb and managing index in actual state. Module suppose to have following configuration:
```
mongo: {
	main: { // this is alias for db
		url:"mongodb://localhost:27017/vungle-bilboard",
		scfg: {auto_reconnect: true, poolSize: 100},
		ccfg: {native_parser: true, w: 1}
	}, // we can have another dbs defined here
}
```
Module has following API:
* getDb(prm{name:alias},cb{null,db})
Function return initiate database object (connection)
* ensureIndex(col, index, options, cb)
Function has the same semantics as normal MongoDB function. Works as a wrapper that helps to intercept and register all indexs that application is expect to see in db
* dropUnusedIndexes(alias,cb)
Function drops all index that was not requested by app using ensureIndex. Used to keep db it good shape (without stale/unsused indexes)

### obac (Object Access Control)
Most of the time applications need sort of permission control. Thee is no solution that one fits all but this module supposed to provide some more or less generic means to implement flexible permission control.

* getPermission(t,p,cb)
  * t - generic toket that identify current security context (like current user)
  * p._id - if of object against which we checking permission (like do I have access to user with _id). Ther is special _id called `global` which suppose global access.
  * p.throw - flag if we need just return true|fale or throw "Unauthorized" exception
  * p.action - action that I want to perform (like `edit`,`view`...)
* getPermissions(t,p{rules:[]}
Just a helper to check multiple rules at once. Each rule correspond to parameters of getPermission. Function return array for reply for each rule lile [{"user.edit":{_id1:true,_id2:false}}]
* getGrantedIds(t, p, cb)
Function has parameters like getPermission but excpet p._id. It is supposed to return all object that are available for cetain secirity context t (user) for p.action. Function suppose to answer to questions like which users I can see.
* register(actions, module, face:{permission:function,grantesIds:function)
Register function(s) that does actual check of permission for certain actions. Modules allows to register function to check permission or fetch grantedIds or actually both. Functions have following signatures and pupose:
  * permission(t,p{action:,_id:})
  Check if certain p.action is applicable for p._id.
  * grantedIds(t,p{action:})
  Return list of ids that are allowed for certain action.

Some recommendations and observations:
* For actions names it is better to use dot notation that denotest object class and action, like `user.edit`. This is easier to recognize and better fits wildcards.
* Object ids are not bound to database and can be literally anything. As an example think about some table in the application that should show different columns for different user. It is possible to define "table.view" permission and use ids like column names (name,phone,...).

### validate
Module is supposed to make extendable JsonSchema validation and it is based on https://github.com/litixsoft/lx-valid.

* check(id, obj, opts, cb)
  * `id` alias for object schema to be used for validation
  * `obj` object to validate
  * `opts.isUpdate` indication that object is MongoDB upate object (e.g. $set:{a:1})
* register(id, schema)
Function registers schema for certain alias. Need to note that schema should be in form of mongodb update which allows multiple module to contribute to single alias. Example:
    ```
    register("company", {
    	$set: {
    		properties: {
    			_id: {
    				type: "mongoId"
    			},
    			code: {
    				type: "string",
    				required: false,
    				pattern: /^(\d{1,})?$/,
    				messages: {
    					conform: "code is not valid. Please, use numeric format"
    				}
    			},
    			CNPJ: {
    				type: "string",
    				required: false,
    				pattern: /^(\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2})?$/,
    				messages: {
    					conform: "CNPJ is not valid. Please, use 00.000.000/0000-00 format"
    				}
    			},
    ```

### cache (mongocache)
This is generic cache module and specifically mongodb implementation. It stores pure JSON values for arbitrary keys with provided lifetime value. For good practice reffered by other modules as `cache` module which assumes that some app might provide other than mongodb implementaion (like Redis)

* register(id, opts{maxAge:}, cb)
Register named (id) cache with options. So far only maxAge is supported
* set(id,k,v,cb)
Set value (v) for key (k) for cache (id)
* get(id,k,cb)
Get value for key (k) for chache (id)
* has(id,k,cb)
Check if cache has value for key (k) for cache (id)
* unset(id,k,cb)
Unset value for key (k) for cache (id)
* reset(id,cb)
Clean / reset entire cache (id)

## Migration from < 2.x to 2.x

###  prefixify default value for `_b_` is true/false rather than 1/0
This is trivial yet important mistake that is fixed in 2.x. Changes in app logic
can be very significant because this affect data in DB. So in order to keep old
behavior use `defaults.prefixify.legacyBoolean=true'

### by default module is not provided by router unless directly requested
Use local module `reqs.router=true` when appropriate or keep old behavior
globally with `defaults.module.reqs.router=true`

### by default module router is not loaded with any express middleware
Load your own if required in module initalization or keep old behavior locally
for module with `reqs.globalUse=true` or globally with `defaults.module.reqs.globalUse=true`

### obac.register is now synchronous function
Adjust code to use it in this way or globally keep old behavior with
`defaults.obac.registerStillSync=true`

### restapi now required declaration of module / functions visibility
This is the matter of app security and there is no fallback behavior. From now
on api visibility need to be explicetly defined:
```
config:{
    restapi: {
     modules:{"statistics":1,"users":1,"web":10, // enable/disable entire modules
       "obac":{blacklist:{"register":1}}, // black list one function
       "email":{whitelist:{"getSendingStatuses":1}}} // whitelist one function
      }
    }
}
```

### tinyback now support multiprocess configuration
This can be enabled almost transparently if required by specifying module target
in load configuration to anything except "root" and "local". The important is to
prevent multiple port listeners to be started so adjust your application code
to start http server only when this condition is not passed:
```
if (app.target && app.target!="root")
  return;
```
