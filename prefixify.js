!(function (factory) {
	if (typeof define === 'function' && define.amd) {
		// AMD (Register as an anonymous module)
		define(['lodash'], factory);
	} else if (typeof exports === 'object') {
		// Node/CommonJS
		module.exports = factory(require('lodash'));
	} else {
		// Browser globals
		factory(_);
	}
}(function (_) {
	var translate = {
		"_i_": function (pr) {
			pr = parseInt(pr);

			if (!_.isNaN(pr))
				return pr;
		},
		"_s_": function (pr) {
			return pr.toString();
		},
		"_id": function (pr) {
			return pr.toString();
		},
		"_f_": function (pr) {
			pr = parseFloat(pr);

			if (!_.isNaN(pr))
				return pr;
		},
		"_t_": function (pr) {
		},
		"_dt": function (pr) {
			var t = Date.parse(pr);
			if (!isNaN(t))
				return new Date(t);
			else if (!isNaN(parseInt(pr)))
				return new Date(parseInt(pr));
			else if (_.isDate(pr))
				return pr;
		},
		"_b_": function (pr) {
			if (pr === true || pr === 1 || pr === "true" || pr === "1")
				return 1;
			if (pr === false || pr === 0 || pr === "false" || pr === "0" || pr === null || pr === "null")
				return 0;
		}
	};

	function sortfix(obj) {
		var nobj = {};
		_.each(obj, function (v, k) {
			nobj[k] = parseInt(v);
		});
		return nobj;
	}

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
								_.attempt(function () { na.push(translate[prefix](a)); });
							});
							no[op]=na;
						} else {
							_.attempt(function () { no[op] = translate[prefix](val); } );
						}
					});
					nobj[k]=no;
				} else {
					// plain value then
					_.attempt(function () { nobj[k] = translate[prefix](v); });
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
			if (_.isFunction(v) || _.isUndefined(v))
				return;

			var prefix = null;
			if (k.length > 2 && k[0] == "_")
				prefix = k.substr(0,3);

			if (prefix && translate[prefix]) {
				var nv;
				_.attempt(function () { nv = translate[prefix](v); });
				if (_.isUndefined(nv)) {
					if (opts && opts.strict)
						throw new Error("Wrong field format: "+k);
					delete nobj[k];
				} else if (nv!==v)
					nobj[k] = nv;
			} else if (_.isPlainObject(v) || _.isArray(v)) {
				datafix(v,opts);
			}
		});
		return nobj;
	}

	return {
		queryfix:queryfix,
		datafix:datafix,
		data:datafix,
		query:queryfix,
		sort:sortfix,
		register:function (prefix, transform) {
			translate[prefix]=transform;
		}
	};
}));
