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

var CustomError = module.exports.CustomError  = function (message, subject) {
  this.constructor.prototype.__proto__ = Error.prototype;
  Error.captureStackTrace(this, this.constructor);
  this.name = this.constructor.name;
  this.message = message;
  this.subject = subject;
};

module.exports.createApp = function (cfg, cb) {
	var app = express();
	app.use(function (req, res, next) {
		req.setMaxListeners(20);
		next();
	});
	app.use(require("compression")());
	app.use(cookieParser());
	app.use(bodyParser.json({ limit: "20mb" }));
	app.use(bodyParser.raw({ limit: "50mb" })); // to parse getsentry "application/octet-stream" requests
	app.use(bodyParser.urlencoded({ extended: true }));
	app.use(multer());
	var api = {};
	var locals = {};
	var auto = {};
	var registered = {};
	var requested = {};

	_.each(cfg.modules, function (module) {
		registered[module.name]=1;
		var mod = module.object || null;
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
			mod.init({api:api,locals:locals,cfg:cfg.config,app:this,express:app,router:router}, safe.sure(cb, function (mobj) {
				console.log("loaded "+ module.name + " in "+((new Date()).valueOf()-dt.valueOf())/1000.0+" s");

				api[module.name]=mobj.api;
				cb();
			}));
		});
		auto[module.name]=args;
	});
	var missing = _.difference(_.keys(requested),_.keys(registered));
	if (missing.length)
		return safe.back(cb, new Error("Missing module dependancies: " + missing.join(',')));
	var dt = new Date();
	safe.auto(auto, safe.sure(cb, function () {
		console.log("-> ready in "+((new Date()).valueOf()-dt.valueOf())/1000.0+" s");
		cb(null, {express:app,api:api,locals:locals});
	}));
};

module.exports.restapi = function () {
	return {
		init: function (ctx, cb) {
			ctx.router.all("/:token/:module/:target",function (req, res) {
				if (ctx.locals.newrelic)
					ctx.locals.newrelic.setTransactionName(req.method+"/"+(req.params.token=="public"?"public":"token")+"/"+req.params.module+"/"+req.params.target);
				var next = function (err) {
					var statusMap = {"Unauthorized":401,"Access forbidden":403};
					var code = statusMap[err.subject] || 500;

					res.status(code).json(_.pick({message: err.message, subject: err.subject}, _.isString));
				};
				if (!ctx.api[req.params.module])
					throw new Error("No api module available");
				if (!ctx.api[req.params.module][req.params.target])
					throw new Error("No function available");

				ctx.api[req.params.module][req.params.target](req.params.token, (req.method == 'POST')?req.body:req.query, safe.sure(next, function (result) {
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

					res.json(result);
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
	var translate = {
		"_i_": function (pr) {
			if (!isNaN(parseInt(pr)))
				return parseInt(pr);
		},
		"_s_": function (pr) {
			return pr.toString();
		},
		"_f_": function (pr) {
			if (!isNaN(parseFloat(pr)))
				return parseFloat(pr);
		},
		"_t_": function (pr) {
		},
		"_dt": function (pr) {
			var t = Date.parse(pr);
			if (!isNaN(t))
				return new Date(t);
			else if (!isNaN(parseInt(pr)))
				return new Date(parseInt(pr));
			else if (pr instanceof Date)
				return pr;
		},
		"_b_": function (pr) {
			if (_.contains([true,"true",1,"1"], pr))
				return 1;
			if (_.contains([false,"false",0,"0",null,"null",""], pr))
				return 0;
		}
	};

	function queryfix(obj, opts) {
		if (!obj) return null;
		var nobj = {};
		_.each(obj, function (v, k) {
			// query can use dot notation for names
			// last component should refer to actual type
			var prefix = k.match(/(_..).*$/);
			if (prefix)
				prefix = prefix[1];

			if (prefix && translate[prefix]) {
				// object meand op, like {$gt:5,$lt:8}
				if (_.isPlainObject(v)) {
					var no = {};
					_.each(v, function (val, op) {
						// op value is array {$in:[1,2,4]}
						if (_.isArray(val)) {
							var na = [];
							_.each(val, function (a) {
								try { na.push(translate[prefix](a)); } catch (e) {}
							});
							no[op]=na;
						} else {
							try { no[op] = translate[prefix](val); } catch (e) {}
						}
					});
					nobj[k]=no;
				} else {
					// plain value then
					try { nobj[k] = translate[prefix](v); } catch (e) {}
				}
			} else {
				if (_.isPlainObject(v))
					nobj[k]=queryfix(v,opts);
				else
					nobj[k]=v;
			}
		});
		return nobj;
	}

	function datafix(obj,opts) {
		var nobj = obj;
		_.each(obj, function (v, k) {
			if (_.isFunction(v))
				return;

			var prefix = null;
			if (k.length > 2 && k[0] == "_")
				prefix = k.substr(0,3);

			if (prefix && translate[prefix]) {
				var nv;
				try { nv = translate[prefix](v); } catch (e) {}
				if (_.isUndefined(nv)) {
					if (opts && opts.strict)
						throw new Error("Wrong field format: "+k);
					delete nobj[k];
				} else if (nv!==v)
					nobj[k] = nv;
			} else if (_.isObject(v) || _.isArray(v)) {
				datafix(v,opts);
			}
		});
		return nobj;
	}

	return {
		reqs:{router:false},
		init:function (ctx,cb) {
			cb(null, {
				api:{
					queryfix:queryfix,
					datafix:datafix,
					register:function (prefix, transform) {
						translate[prefix]=transform;
					}
				}
			});
		}
	};
};

module.exports.mongodb = function () {
	return {
		reqs:{router:false},
		init:function (ctx,cb) {
			var mongo = require("mongodb");
			ctx.api.prefixify.register("_id",function (pr) {
				return new mongo.ObjectID(pr.toString());
			});

			var dbcache = {};
            var indexinfo = {};
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
							cb(null,db);
						}));
					},
                    ensureIndex:function (col, index, options, cb) {
                        if (_.isFunction(options)) {
                            cb = options;
                            options = {};
                        }

                        var dbkey = col.db.serverConfig.name+"/"+col.db.databaseName;
                        var dbif = indexinfo[dbkey];
                        if (!dbif) {
                            dbif = indexinfo[dbkey]={};
                        }
                        var colkey = col.collectionName;
                        var cif = dbif[colkey];
                        if (!cif) {
                            cif = dbif[colkey]={_id_:true};
                        }
                        col.ensureIndex(index, options, safe.sure(cb, function (indexname) {
                            cif[indexname]=true;
                            cb();
                        }));
                    },
                    dropUnusedIndexes:function (db, cb) {
                        var dbkey = db.serverConfig.name+"/"+db.databaseName;
                        var dbif = indexinfo[dbkey];
                        if (!dbif)
                            return safe.back(cb, null);
                        safe.each(_.keys(dbif), function (colName, cb) {
                            db.indexInformation(colName, safe.sure(cb, function (index) {
                                var unused = _.difference(_.keys(index),_.keys(dbif[colName]));
                                safe.each(unused, function (indexName,cb) {
                                    db.dropIndex(colName, indexName, cb);
                                },cb);
                            }));
                        },cb);
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
					getPermissions:function (t, p, cb) {
						var result = {};
						safe.forEachOf(p.rules, function (rule, cb) {
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
								var answer = null;
								_.each(answers, function (voice) {
									answer = (!answer)?voice:(answer?voice:answer);
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
							cb(null, _.intersection.apply(_,answers));
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
							var es = "Validation fails: ";
							_.each(res.errors, function (error) {
								es+=error.property + " " + error.message+" ";
								if (error.expected)
									es+=", expected  " + JSON.stringify(error.expected);
								if (error.actual)
									es+=", actual " + JSON.stringify(error.actual);
								es+="; ";
							});
							var err = new CustomError(es, "InvalidData");
							err.data = res.errors;
							safe.back(cb,err);
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
	return {
		reqs:{router:false},
		init:function (ctx,cb) {
            ctx.api.mongo.getDb({}, safe.sure(cb, function (db) {
    			cb(null, {
    				api:{
    					register:function (id, opts, cb) {
                            db.collection("cache_"+id, safe.sure(cb, function (col) {
                                var options = {};
                                if (opts.maxAge) {
                                    options.expireAfterSeconds = 3600;
                                }
                                ctx.api.mongo.ensureIndex(col,{k:1},options,safe.sure(cb, function () {
                                    entries["cache_"+id] = col;
                                    cb();
                                }));
                            }));
    					},
    					set:function (id,k,v,cb) {
                            var col = entries["cache_"+id];
                            if (!col) return safe.back(cb,new Error("Cache "+id+" is not registered"));
                            col.update({k:k.toString()},{$set:{v:v}},{upsert:true},cb);
                        },
                        get:function (id,k,cb) {
                            var col = entries["cache_"+id];
                            if (!col) return safe.back(cb,new Error("Cache "+id+" is not registered"));
                            col.findOne({k:k.toString()},safe.sure(cb, function (rec) {
                                if (!rec)
                                    cb(null,null);
                                else
                                    cb(null,rec.v);
                            }));
                        },
                        has:function (id,k,cb) {
                            var col = entries["cache_"+id];
                            if (!col) return safe.back(cb,new Error("Cache "+id+" is not registered"));
                            col.find({k:k.toString()}).limit(1).count(cb);
                        },
                        unset:function (id,k,cb) {
                            var col = entries["cache_"+id];
                            if (!col) return safe.back(cb,new Error("Cache "+id+" is not registered"));
                            col.remove({k:k.toString()},cb);
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
