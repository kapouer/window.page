var State = require('./state');
var Query = require('./query');

exports.parse = function(str) {
	var dloc = document.location;
	var loc;
	if (str == null || str == "") {
		loc = dloc;
	} else if (typeof str == "string") {
		loc = new URL(str, dloc);
	} else {
		loc = str;
	}
	var obj = new State();
	if (loc.referrer) obj.referrer = loc.referrer;
	obj.pathname = loc.pathname;
	obj.query = loc.query ? Object.assign({}, loc.query) : Query.parse(loc.search);
	if (!obj.pathname) obj.pathname = "/";
	else if (obj.pathname[0] != "/") obj.pathname = "/" + obj.pathname;

	var hash = loc.hash || (str == null ? dloc.hash : null);
	if (hash && hash[0] == "#") hash = hash.substring(1);

	if (hash != null && hash != '') obj.hash = hash;

	if (exports.sameDomain(loc, dloc)) {
		delete obj.port;
		delete obj.hostname;
		delete obj.protocol;
	} else {
		if (!obj.hostname) {
			obj.hostname = loc.hostname;
			if (!obj.port) obj.port = loc.port;
		}
		if (!obj.protocol) obj.protocol = loc.protocol;
		if (canonPort(obj)) {
			delete obj.port;
		}
	}
	return obj;
};

exports.format = function(obj) {
	var dloc = document.location;
	if (typeof obj == "string") obj = exports.parse(obj);
	else obj = Object.assign({}, obj);
	if (obj.path) {
		var parsedPath = exports.parse(obj.path);
		obj.pathname = parsedPath.pathname;
		obj.query = parsedPath.query;
		obj.hash = parsedPath.hash;
		delete obj.path;
	}
	var qstr;
	if (obj.query) qstr = Query.format(obj.query);
	else if (obj.search) qstr = obj.search[0] == "?" ? obj.search.substring(1) : obj.search;
	obj.search = qstr;

	var keys = ["pathname", "search", "hash"];
	var relative = !obj.protocol && !obj.hostname && !obj.port;
	if (!relative) keys.unshift("protocol", "hostname", "port");

	var key;
	for (var i=0; i < keys.length; i++) {
		key = keys[i];
		if (obj[key] == null) obj[key] = dloc[key];
		else break;
	}

	var str = obj.pathname || "";
	if (qstr) str += '?' + qstr;
	if (obj.hash) str += '#' + obj.hash;
	if (!relative) {
		str = obj.protocol + '//' + obj.hostname + canonPort(obj) + str;
	}
	return str;
};

exports.sameDomain = function(a, b) {
	if (typeof a == "string") a = exports.parse(a);
	if (typeof b == "string") b = exports.parse(b);
	var loc = document.location;
	var pr = loc.protocol;
	var hn = loc.hostname;
	var po = loc.port;
	return (a.protocol || pr) == (b.protocol || pr) && (a.hostname || hn) == (b.hostname || hn) && (a.port || po) == (b.port || po);
};

exports.samePathname = function(a, b) {
	if (typeof a == "string") a = exports.parse(a);
	if (typeof b == "string") b = exports.parse(b);
	if (exports.sameDomain(a, b)) {
		return a.pathname == b.pathname;
	} else {
		return false;
	}
};

exports.sameQuery = function(a, b) {
	if (typeof a == "string") a = exports.parse(a);
	if (typeof b == "string") b = exports.parse(b);
	var aquery = Query.parse(a.query || a.search);
	var bquery = Query.parse(b.query || b.search);
	return Query.format(aquery) == Query.format(bquery);
};

exports.samePath = function(a, b) {
	if (typeof a == "string") a = exports.parse(a);
	if (typeof b == "string") b = exports.parse(b);
	if (exports.samePathname(a, b)) {
		return exports.sameQuery(a, b);
	} else {
		return false;
	}
};

function canonPort(obj) {
	var port = obj.port;
	if (!port) return '';
	var proto = obj.protocol;
	if ((port == 80 && proto == "http:") || (port == 443 && proto == "https:")) {
		return '';
	} else {
		return ':' + port;
	}
}
