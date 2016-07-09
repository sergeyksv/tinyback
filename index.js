/*jslint node: true */
var _ = require("lodash");
var safe = require("safe");
var path = require("path");
var express = require('express');
var moment = require('moment');
var cookieParser = require('cookie-parser');
var bodyParser = require('body-parser');
var multer = require('multer');
var lxval = require('lx-valid');
var crypto = require('crypto');
var child_process = require("child_process");
var Hook = require('tinyhook').Hook;
var http = require('http');

var CustomError = module.exports.CustomError	= function (message, subject) {
	this.constructor.prototype.__proto__ = Error.prototype;
	Error.captureStackTrace(this, this.constructor);
	this.name = "CustomError";
	this.message = message;
	this.subject = subject;
};

/**
 * @property {Object} invalid validation result object
 * @type {Function}
 */
var ValidationError = module.exports.ValidationError = function (invalid) {
	this.constructor.prototype.__proto__ = Error.prototype;
	var es = "Validation fails: ";

	_.each(invalid.errors, function (error) {
		es += error.property + " " + error.message + " ";
		if (error.expected)
			es += ", expected	" + JSON.stringify(error.expected);
		if (error.actual)
			es += ", actual " + JSON.stringify(error.actual);
		es += "; ";
	});

	this.name = 'ValidationError';
	this.message = es;
	this.subject = 'Invalid Data';
	this.data = _.reduce(invalid.errors, function (m, f) {
		m.push(_.pick(f, ['property', 'message']));
		return m;
	},[]);
};

module.exports.createApp = function (cfg, cb) {
	// inject some modules for internal use if not requested
	var hasRegistry = false;
	_.each(cfg.modules, function (module) {
		if (module.name == "_t_registry")
			hasRegistry = true;
	});
	if (!hasRegistry)
		cfg.modules.unshift({target:"root", name:"_t_registry",object:_t_registry()});

	// create express app (might need to create it on demand ?)
	var app = express();
	app.use(function (req, res, next) {
		req.setMaxListeners(20);
		next();
	});
	app.use(require("compression")());
	app.use(cookieParser());
	app.use(bodyParser.json({ limit: cfg.config.app.postLimit || "20mb" }));
	app.use(bodyParser.raw({ limit: cfg.config.app.postLimit || "50mb" })); // to parse getsentry "application/octet-stream" requests
	app.use(bodyParser.urlencoded({ extended: true, limit: cfg.config.app.postLimit || "20mb"}));
	app.use(multer());
	var api = {};
	var locals = {};
	var auto = {};
	var registered = {};
	var requested = {};
	var lmodules = {};
	var proxy = null; // proxy might be required for multinode

	var nodes = {};
	var thisNode = "root";

	var hook = new Hook( {
		name: thisNode,
		port: cfg.hookPort
	});
	hook.start();

	hook.once("hook::ready", function () {

	// lets check if we was launched as tiny back node
	_.each(process.argv, function (param) {
		var match = /--tinybacknode=(.*)/.exec(param);
		if (match) {
			var params = JSON.parse(match[1]);
			thisNode = params.target;
			nodes = params.nodes;
			// when running as node we need to listen on random port
			// and announce it
			var httpServer = http.createServer(app);
			httpServer.listen(0, function () {
				var port = httpServer.address().port;
				hook.emit("tinyback::targetproxy::"+thisNode,{port:port});
				hook.on("*::tinyback::wanttargetproxy::"+thisNode, function (target) {
					hook.emit("tinyback::targetproxy::"+thisNode,{port:port});
				});
			})
		}
	})

	hook.on("*::tinyback::wantmoduleproxy", function (mname) {
		if (api[mname]) {
			hook.emit("tinyback::moduleschema::"+mname,_.keys(api[mname]));
		}
	});

	var cbs = {};
	var i = 0;
	hook.on("*::tinyback::reply::"+thisNode, function (reply) {
		var cb = cbs[reply.rn];
		if (cb) {
			delete cbs[reply.rn];
			var err = null;
			if (reply.err) {
				if (reply.err.name ==  "CustomError") {
					err = new CustomError(reply.err.message, reply.err.subject)
				}
				else
					err = new Error(reply.err);
			}
			cb(err, reply.res);
		}
	});

	_.each(cfg.modules, function (module) {
		registered[module.name]=1;
		var mod = module.object || null;
		// setting default value
		if (!module.target || cfg.forceRootTarget)
		 	module.target = "root";
		// checkinng if this module is local to this node or not
		var local = module.target == "local" || module.target == thisNode;
		if (module.require) {
			var mpath = module.require;
			if (mpath.charAt(0)==".")
				mpath = path.resolve(path.dirname(require.main.filename),mpath);
			mod = require(mpath);
		}
		if (!mod)
			return cb(new Error("Can't not load module " + module.name));
		var args = _.clone(module.deps || []);
		args = _.union(mod.deps || [],args);
		_.each(args, function (m) {
			requested[m]=1;
		});
		args.push(function (cb) {
			var router = null;
			if (!mod.reqs || mod.reqs.router!==false) {
				router = express.Router();
				app.use("/"+module.name,router);
			}
			var dt = new Date();
			if (local) {
				mod.init({target:thisNode, api:api,locals:locals,cfg:cfg.config,app:this,router:router}, safe.sure(cb, function (mobj) {
					if (!(module.target == 'local' && thisNode != 'root'))
						console.log(thisNode + " loaded "+ module.name + " in "+((new Date()).valueOf()-dt.valueOf())/1000.0+" s");
					var lapi = api[module.name]=mobj.api;
					lmodules[module.name]=1;
					hook.emit("tinyback::moduleschema::"+module.name,_.keys(mobj.api));
					nodes[module.target]=1;
					hook.on("*::tinyback::call::"+module.name, function (call) {
						call.params[call.params.length-1] = function (err, res) {
							hook.emit("tinyback::reply::"+call.node,{rn:call.rn,err:err?JSON.parse(JSON.stringify(err)):null, res:res});
						};
						lapi[call.func].apply(lapi,call.params);
					});
					cb();
				}));
			} else {
				if (!nodes[module.target] && thisNode == "root") {
					// need to launch for for dedicated target
					var forkparams = Array.prototype.slice.call(process.argv,2);
					forkparams.push("--tinybacknode="+JSON.stringify({target:module.target,nodes:nodes}));
					hook.emit("hook::fork",{script:process.argv[1], params:forkparams});
				}
				hook.once("*::tinyback::moduleschema::"+module.name, function (schema) {
					var apim = {};
					_.each(schema, function (f) {
						apim[f]= function () {
							var cb = arguments[arguments.length-1];
							var args = safe.args.apply(0, arguments);
							args[args.length-1]=null;
							var rn = thisNode+(i++);
							cbs[rn]=cb;
							hook.emit("tinyback::call::"+module.name,{node:thisNode, func:f, rn: rn, params:args});
						};
					});
					api[module.name] = apim;
					nodes[module.target]=1;
					cb();
				});
				hook.emit("tinyback::wantmoduleproxy",module.name);
				if (router) {
					var port = null;
					hook.emit("tinyback::wanttargetproxy::"+module.target);
					hook.on("*::tinyback::targetproxy::"+module.target, function (data) {
						port = data.port;
					})
					proxy = proxy || require('http-proxy').createProxyServer({});
					app.all("/"+module.name+'*',function (req, res) {
						if (port)
							proxy.web(req, res, { target: 'http://localhost:'+port });
					});
				}
			}
		});
		auto[module.name]=args;
	});
	var missing = _.difference(_.keys(requested),_.keys(registered));
	if (missing.length)
		return safe.back(cb, new Error("Missing module dependancies: " + missing.join(',')));
	var dt = new Date();
	safe.auto(auto, safe.sure(cb, function () {
		if (thisNode == "root")
			console.log("-> ready in "+((new Date()).valueOf()-dt.valueOf())/1000.0+" s");
		cb(null, {express:app,api:api,locals:locals,target:thisNode});
	}));
});
};

module.exports.restapi = function () {
	return {
		deps:['tson'],
		init: function (ctx, cb) {
			ctx.router.all("/:token/:module/:target",function (req, res) {
				if (ctx.locals.newrelic)
					ctx.locals.newrelic.setTransactionName(req.method+"/"+(req.params.token=="public"?"public":"token")+"/"+req.params.module+"/"+req.params.target);
				var next = function (err) {
					var statusMap = {"Unauthorized":401,"Access forbidden":403,"Invalid Data":422};
					var code = statusMap[err.subject] || 500;
					res.status(code).json(_.pick(err,['message','subject','data']));
				};
				if (!ctx.api[req.params.module])
					throw new Error("No api module available");
				if (!ctx.api[req.params.module][req.params.target])
					throw new Error("No function available");

				var params = (req.method == 'POST')?req.body:req.query;

				if (params._t_son=='in' || params._t_son=='both')
					params = ctx.api.tson.decode(params);

				ctx.api[req.params.module][req.params.target](req.params.token, params, safe.sure(next, function (result) {
					if (params._t_son=='out' || params._t_son=='both')
						result = ctx.api.tson.encode(result);

					var maxAge = 0;
					if (req.query._t_age) {
						var age = req.query._t_age;
						var s = age.match(/(\d+)s?$/); s = s?parseInt(s[1]):0;
						var m = age.match(/(\d+)m/); m = m?parseInt(m[1]):0;
						var h = age.match(/(\d+)h/); h = h?parseInt(h[1]):0;
						var d = age.match(/(\d+)d/); d = d?parseInt(d[1]):0;
						maxAge = moment.duration(d+"."+h+":"+m+":"+s).asSeconds();
					}

					if (maxAge) {
						res.header('Cache-Control','public');
						res.header("Max-Age", maxAge );
						res.header("Expires", (new Date((new Date()).valueOf()+maxAge*1000)).toGMTString());
					} else {
						res.header('Cache-Control','private, no-cache, no-store, must-revalidate');
						res.header('Expires', '-1');
						res.header('Pragma', 'no-cache');
					}

					res.json(_.isUndefined(result)?null:result);
				}));
			});
			cb(null, {
				api: {
				}
			});
		}
	};
};

module.exports.prefixify = function () {
	return {
		reqs:{router:false},
		init:function (ctx,cb) {
			cb(null, {api:require('./prefixify')});
		}
	};
};

module.exports.tson = function () {
	return {
		reqs:{router:false},
		init:function (ctx,cb) {
			cb(null, {api:require('./tson')});
		}
	};
};

function _t_registry() {
	return {
		reqs:{router:false},
		deps:[],
		init:function (ctx,cb) {
			var store = {};
			cb(null, {
				api:{
					set:function (k,v,cb) {
						store[k] = v;
						safe.back(cb);
					},
					get:function (k, cb) {
						safe.back(cb,null,store[k]);
					},
					merge:function (k, v, cb) {
						var data = store[k];
						if (!data)
						 	data = store[k]={};
						_.merge(data,v);
						cb();
					}
				}
			});
		}
	};
};

module.exports._t_registry = _t_registry;

module.exports.mongodb = function () {
	return {
		reqs:{router:false},
		deps:['prefixify','_t_registry'],
		init:function (ctx,cb) {
			var mongo = require("mongodb");
			ctx.api.prefixify.register("_id",function (pr) {
				return new mongo.ObjectID(pr.toString());
			});

			var dbcache = {};
			cb(null, {
				api:{
					getDb:function (prm,cb) {
						var name = prm.name || "main";
						if (dbcache[name])
							return safe.back(cb,null,dbcache[name]);
						var cfg = ctx.cfg.mongo[name];
						if (!cfg)
							return safe.back(cb, new Error("No mongodb database for alias "+name));

						var dbc = new mongo.Db(
							cfg.db,
							new mongo.Server(
								cfg.host,
								cfg.port,
								cfg.scfg
							),
							cfg.ccfg
						);
						dbc.open(safe.sure(cb, function (db) {
							dbcache[name]=db;
							if(!cfg.auth)
								return cb(null,db);
							db.authenticate(cfg.auth.user,cfg.auth.pwd,cfg.auth.options,safe.sure(cb,function(){
								cb(null,db);
							}));
						}));
					},
					ensureIndex:function (col, index, options, cb) {
						if (_.isFunction(options)) {
							cb = options;
							options = {};
						}
						var dbkey = "";
						if (col.s) {
							dbkey = col.s.db.serverConfig.host +":"+ col.s.db.serverConfig.port +"/"+ col.s.db.databaseName;
						}else{
							dbkey = col.namespace || col.db.serverConfig.name+"/"+col.db.databaseName;
						}
						var indexinfo = {};
						var dbif = indexinfo[dbkey] = {};
						var colkey = col.collectionName;
						var cif = dbif[colkey];
						if (!cif) {
							cif = dbif[colkey]={_id_:true};
						}
						col.ensureIndex(index, options, safe.sure(cb, function (indexname) {
							cif[indexname]=true;
							ctx.api._t_registry.merge("indexinfo",indexinfo, cb);
						}));
					},
					dropUnusedIndexes:function (db, cb) {
						if (ctx.target!="root")
							return safe.back(cb);
						ctx.api._t_registry.get("indexinfo", safe.sure(cb, function (indexinfo) {
							var dbkey = "";
							if (db.serverConfig.name) {
								dbkey = db.serverConfig.name+"/"+db.databaseName;
							}else{
								dbkey = db.serverConfig.host +":"+ db.serverConfig.port +"/"+ db.databaseName
							}
							var dbif = indexinfo[dbkey];
							if (!dbif)
								return safe.back(cb, null);
							safe.eachOf(dbif, function (coll, colName, cb) {
								db.indexInformation(colName, safe.sure(cb, function (index) {
									var unused = _.difference(_.keys(index),_.keys(coll));
									safe.each(unused, function (indexName,cb) {
										db.collection(colName).dropIndex(indexName, cb);
									},cb);
								}));
							},cb);
						}))
					}
				}
			});
		}
	};
};

module.exports.obac = function () {
	return {
		reqs:{router:false},
		init:function (ctx,cb) {
			var _acl = [];
			cb(null, {
				api:{
					getPermission: function (t, p, cb) {
						ctx.api.obac.getPermissions(t, {rules:[p]}, safe.sure(cb, function (res) {
							var granted = !!res[p.action][p._id ||'global'];
							if (!p.throw)
								cb(null, granted);
							else
								cb(granted?null:new CustomError("Access denied to "+p.action, "Unauthorized"));
						}));
					},
					getPermissions:function (t, p, cb) {
						var result = {};
						safe.eachOf(p.rules, function (rule, cb) {
							var acl = _.filter(_acl, function (a) {
								return a.r.test(rule.action);
							});
							var checks = [];
							_.each(acl, function (a) {
								if (a.f.permission) {
									checks.push(function (cb) {
										ctx.api[a.m][a.f.permission](t,rule,cb);
									});
								}
							});
							safe.parallel(checks, safe.sure(cb, function (answers) {
								var answer = false;
								// if any arbiter allow some action then
								// we consider it allowed (or check)
								_.each(answers, function (voice) {
									answer |= voice;
								});
								if (!result[rule.action])
									result[rule.action] = {};
								result[rule.action][rule._id || 'global']=!!answer;
								cb();
							}));
						}, safe.sure(cb,function () {
							cb(null,result);
						}));
					},
					getGrantedIds:function (t, p, cb) {
						var acl = _.filter(_acl, function (a) {
							return a.r.test(p.action);
						});
						var checks = [];
						_.each(acl, function (a) {
							if (a.f.grantids) {
								checks.push(function (cb) {
									ctx.api[a.m][a.f.grantids](t,p,cb);
								});
							}
						});
						safe.parallel(checks, safe.sure(cb, function (answers) {
							cb(null, answers.length==1?answers[0]:_.intersection.apply(_,answers));
						}));
					},
					register:function(actions, module, face) {
						_.each(actions, function (a) {
							_acl.push({m:module, f:face, r:new RegExp(a.replace("*",".*"))});
						});
					}
				}
			});
		}
	};
};

module.exports.validate = function () {
	var updater = require("./updater.js");
	var entries = {};
	return {
		reqs:{router:false},
		init:function (ctx,cb) {
			cb(null, {
				api:{
					async: lxval.asyncValidate,
					register:function (id, obj) {
						var op = new updater(obj);
						entries[id] = entries[id] || {};
						op.update(entries[id]);
					},
					check:function (id, obj, opts, cb) {
						var valFn = function (data, schema, opts) {
							return lxval.validate(data, schema, opts);
						};
						if (!cb) {
							cb = opts;
							opts = {unknownProperties:"error"};
						}
						opts = _.defaults(opts, {unknownProperties:"error"});
						if (opts.isUpdate) {
							var op = new updater(obj);
							var sim = {};
							op.update(sim);
							obj = sim;
							valFn = lxval.getValidationFunction();
						}
						var schema = entries[id] || {};
						var res = valFn(obj, schema, opts);
						if (!res.valid) {
							safe.back(cb, new ValidationError(res));
						} else {
							safe.back(cb, null, obj);
						}
					}
				}
			});
		}
	};
};

module.exports.mongocache = function () {
	var entries = {};
	var md5sum;
	var safeKey = function (key) {
		var sKey = key.toString();
		if (sKey.length>512) {
			md5sum = crypto.createHash('md5');
			md5sum.update(sKey);
			sKey = md5sum.digest('hex');
		}
		return sKey;
	};
	return {
		reqs:{router:false},
		deps:["mongo"],
		init:function (ctx,cb) {
			ctx.api.mongo.getDb({}, safe.sure(cb, function (db) {
				cb(null, {
					api:{
						register:function (id, opts, cb) {
							if (id.indexOf("/")!=-1)
								return safe.back(cb,new Error("Found not allowed characters in cache id"));
							var col = entries["cache_"+id];
							if (col)
								return safe.back(cb,new Error("Cache "+id+" is already registered"));
							db.collection("cache_"+id, safe.sure(cb, function (col) {
								ctx.api.mongo.ensureIndex(col,{d:1},{expireAfterSeconds: opts.maxAge || 3600},safe.sure(cb, function () {
									entries["cache_"+id] = col;
									cb();
								}));
							}));
						},
						set:function (id,k,v,cb) {
							var col = entries["cache_"+id];
							if (!col) return safe.back(cb,new Error("Cache "+id+" is not registered"));
							col.update({_id:safeKey(k)},{$set:{d:new Date(),v:JSON.stringify(v)}},{upsert:true},cb);
						},
						get:function (id,k,cb) {
							var col = entries["cache_"+id];
							if (!col) return safe.back(cb,new Error("Cache "+id+" is not registered"));
							col.findOne({_id:safeKey(k)},safe.sure(cb, function (rec) {
								if (!rec)
									cb(null,null);
								else
									cb(null,JSON.parse(rec.v));
							}));
						},
						has:function (id,k,cb) {
							var col = entries["cache_"+id];
							if (!col) return safe.back(cb,new Error("Cache "+id+" is not registered"));
							col.find({_id:safeKey(k)}).limit(1).count(cb);
						},
						unset:function (id,k,cb) {
							var col = entries["cache_"+id];
							if (!col) return safe.back(cb,new Error("Cache "+id+" is not registered"));
							col.remove({_id:safeKey(k)},cb);
						},
						reset:function (id, cb) {
							var col = entries["cache_"+id];
							if (!col) return safe.back(cb,new Error("Cache "+id+" is not registered"));
							col.remove({},cb);
						}
					}
				});
			}));
		}
	};
};
