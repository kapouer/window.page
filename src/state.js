var Utils = require('./utils');
var Loc = require('./loc');
var Wait = require('./wait');
var Diff = require('levenlistdiff');
var P = Utils.P;
var debug = Utils.debug;

module.exports = State;

var INIT = "init";
var READY = "ready";
var BUILD = "build";
var PATCH = "patch";
var SETUP = "setup";
var CLOSE = "close";
var ERROR = "error";
var HASH = "hash";
var Stages = [INIT, READY, BUILD, PATCH, SETUP, HASH, ERROR, CLOSE];

var queue;

function State() {
	this.data = {};
	this.chains = {};
}

State.prototype.init = function() {
	var W = window.Page;
	var state = this;
	Stages.forEach(function(stage) {
		W[stage] = function(fn) {
			return state.chain(stage, fn);
		};
		W['un' + stage] = function(fn) {
			return state.unchain(stage, fn);
		};
	});
};

State.prototype.run = function() {
	var state = this;
	if (queue) queue = queue.then(function() {
		return state.run();
	});
	else queue = run(state).then(function(state) {
		queue = null;
		return state;
	});
	return queue;
};

function prerender(ok) {
	var root = document.documentElement;
	if (ok) root.setAttribute('data-prerender', 'true');
	else return root.dataset.prerender == 'true';
}

function run(state) {
	state.init();
	var refer = state.referrer;
	if (!refer) {
		debug("new referrer");
		if (document.referrer) {
			refer = Loc.parse(document.referrer);
		} else {
			refer = new State();
		}
		state.referrer = refer;
	}
	if (refer == state) {
		throw new Error("state and referrer should be distinct");
	}
	delete state.emitter; // in case an already used state has been given
	var samePathname = Loc.samePathname(refer, state);
	return Wait.dom().then(function() {
		Utils.clearListeners(document);
		if (!samePathname && refer.stage) return refer.runChain(CLOSE);
	}).then(function() {
		return state.runChain(INIT);
	}).then(function() {
		// it is up to the default router to NOT load a document upon first load
		// other routers might choose to do otherwise
		if (!samePathname || !refer.prerender) {
			return state.router();
		} else {
			if (!state.emitter) state.emitter = refer.emitter;
		}
	}).then(function(doc) {
		Utils.trackListeners(document, window);
		window.addEventListener('popstate', historyListener.bind(state));
		return state.load(doc || document);
	}).then(function() {
		if (state.prerender == null) state.prerender = prerender();
		state.stage = state.prerender ? SETUP : INIT;
		debug("doc ready at stage", state.stage);
		return state.runChain(READY);
	}).then(function() {
		if (!state.prerender && !samePathname) return (state.runChain(BUILD) || P()).then(function() {
			return state.runChain(PATCH);
		});
	}).then(function() {
		if (!samePathname) {
			prerender(true);
			return Wait.ui().then(function() {
				return state.runChain(SETUP);
			});
		} else if (samePathname && !Loc.sameQuery(state, refer)) {
			return state.runChain(PATCH) || state.runChain(BUILD);
		}
	}).then(function() {
		if (state.hash != refer.hash) return state.runChain(HASH);
	}).catch(function(err) {
		// eslint-disable-next-line no-console
		if (typeof err != "number") console.error(err);
		state.error = err;
		return state.runChain(ERROR)
	}).then(function() {
		return state;
	});
}

State.prototype.emit = function(name) {
	var e = new CustomEvent(name, {
		view: window,
		bubbles: true,
		cancelable: true,
		detail: this
	});
	Utils.all(document, 'script').forEach(function(node) {
		node.dispatchEvent(e);
	});
	if (this.emitter) this.emitter.dispatchEvent(e);
};

State.prototype.runChain = function(name) {
	this.stage = name;
	var chain = this.chains[name];
	if (!chain) chain = this.chains[name] = {};
	debug("run chain", name);
	chain.count = 0;
	chain.promise = P();
	this.emit("page" + name);
	debug("run chain count", name, chain.count);
	if (chain.count) return chain.promise;
};


State.prototype.chain = function(stage, fn) {
	var state = this;
	var ls = fn._pageListeners;
	if (!ls) ls = fn._pageListeners = {};
	var lfn = ls[stage];
	var emitter = document.currentScript;
	if (!emitter) {
		emitter = state.emitter;
		if (!emitter) emitter = state.emitter = document.createElement('div');
	}

	if (!lfn) {
		lfn = ls[stage] = {
			fn: chainListener(stage, fn),
			em: emitter
		};
		emitter.addEventListener('page' + stage, lfn.fn);
	} else {
		debug("already chained", stage, fn);
	}
	var p;
	var curNum = state.stage ? Stages.indexOf(state.stage) : 0;
	var tryNum = Stages.indexOf(stage);
	if (tryNum <= curNum) {
		debug("chain has run, execute fn now", stage);
		p = new Promise(function(resolve) {
			setTimeout(resolve);
		}).then(function() {
			return runFn(stage, fn, state);
		});
	} else {
		debug("chain pending", stage);
		p = P();
	}
	return p;
};

State.prototype.unchain = function(stage, fn) {
	var ls = fn._pageListeners;
	if (!ls) return;
	var lfn = ls[stage];
	if (!lfn) return;
	delete ls[stage];
	lfn.em.removeEventListener('page' + stage, lfn.fn);
};

function chainListener(stage, fn) {
	return function(e) {
		var state = e.detail;
		var chain = state.chains[stage];
		if (chain.count == null) chain.count = 0;
		chain.count++;
		chain.promise = chain.promise.then(function() {
			return runFn(stage, fn, state);
		}).catch(function(err) {
			// eslint-disable-next-line no-console
			console.error(stage, "stage", err);
		});
	};
}

function runFn(stage, fn, state) {
	if (typeof fn == "object" && fn[stage]) return fn[stage](state);
	else return fn(state);
}

State.prototype.load = function(doc) {
	if (doc == document) {
		return P();
	}
	debug("Import new document");
	var states = {};
	var selector = 'script:not([type]),script[type="text/javascript"],link[rel="import"]';
	Utils.all(document, selector).forEach(function(node) {
		var src = node.src || node.href;
		if (src) states[src] = true;
	});

	// if there is no HTMLImports support, some loaded script might contain
	// the HTMLImports polyfill itself, which will load imports however it likes
	// so it's hard to decide which order is good, and it's also impossible to know
	// if that polyfill will be available - so state.load does not preload
	// imports nor does it let them run on insert
	// if there is native support then it's like other resources.

	var nodes = Utils.all(doc, selector);

	nodes.forEach(function(node) {
		// just preload everything
		if (node.nodeName == "SCRIPT") {
			node.setAttribute('type', "none");
		} else if (node.nodeName == "LINK") {
			node.setAttribute('rel', 'none');
			if (!node.import) return; // polyfill already do preloading
		}
		var src = node.src || node.href;
		if (!src) return;
		if (states[src] === true) return;
		// not data-uri
		if (src.slice(0, 5) == 'data:') return;
		states[src] = Utils.get(src, 400).then(function() {
			debug("preloaded", src);
		}).catch(function(err) {
			debug("not preloaded", src, err);
		});
	});

	function loadNode(node) {
		var p = P();
		var src = node.src || node.href;
		var state = states[src];
		var old = state === true;
		var loader = !old && state;
		if (loader) {
			p = p.then(loader);
		}
		return p.then(function() {
			var parent = node.parentNode;
			var cursor;
			if (!old) {
				cursor = document.createTextNode("");
				parent.insertBefore(cursor, node);
				parent.removeChild(node);
			}
			if (node.nodeName == "LINK") {
				node.setAttribute('rel', 'import');
			} else if (node.nodeName == "SCRIPT") {
				node.removeAttribute('type');
			}
			if (old) return;
			var copy = document.createElement(node.nodeName);
			for (var i=0; i < node.attributes.length; i++) {
				copy.setAttribute(node.attributes[i].name, node.attributes[i].value);
			}
			if (node.textContent) copy.textContent = node.textContent;
			var rp;
			if (src) {
				debug("async node loading", src);
				if (node.nodeName == "LINK" && !node.import) {
					debug("not loading import", src);
				} else {
					rp = Wait.node(copy);
				}
			} else {
				debug("inline node loading");
				rp = new Promise(function(resolve) {
					setTimeout(resolve);
				});
			}
			parent.insertBefore(copy, cursor);
			parent.removeChild(cursor);
			if (rp) return rp;
		});
	}

	var root = document.documentElement;
	var nroot = document.adoptNode(doc.documentElement);
	var head = nroot.querySelector('head');
	var body = nroot.querySelector('body');

	var atts = nroot.attributes;

	for (var i=0; i < atts.length; i++) {
		root.setAttribute(atts[i].name, atts[i].value);
	}
	atts = Array.prototype.slice.call(root.attributes);
	for (var j=0; j < atts.length; j++) {
		if (!nroot.hasAttribute(atts[j].name)) nroot.removeAttribute(atts[j].name);
	}

	var parallels = Wait.styles(head, document.head);
	var serials = Utils.all(nroot, 'script[type="none"],link[rel="none"]');

	var state = this;

	return P().then(function() {
		state.mergeHead(head, document.head);
		return parallels;
	}).then(function() {
		return P().then(function() {
			return state.mergeBody(body, document.body);
		});
	}).then(function() {
		// scripts must be run in order
		var p = P();
		serials.forEach(function(node) {
			p = p.then(function() {
				return loadNode(node);
			});
		});
		return p;
	});
};

State.prototype.mergeHead = function(node) {
	this.updateAttributes(document.head, node);
	this.updateChildren(document.head, node);
};

State.prototype.mergeBody = function(node) {
	document.body.parentNode.replaceChild(node, document.body);
};

State.prototype.updateAttributes = function(from, to) {
	var attFrom = from.attributes;
	var attTo = to.attributes;
	Diff(attFrom, attTo, function(att) {
		return att.name + "_" + att.value;
	}).forEach(function(patch) {
		var att = attFrom[patch.index];
		switch (patch.type) {
		case Diff.INSERTION:
			if (patch.item.value) {
				from.setAttribute(patch.item.name, patch.item.value);
			}
			break;
		case Diff.SUBSTITUTION:
			if (att.name != patch.item.name) {
				from.removeAttribute(att.name);
			}
			if (patch.item.value) {
				from.setAttribute(patch.item.name, patch.item.value);
			} else {
				from.removeAttribute(patch.item.name);
			}
			break;
		case Diff.DELETION:
			from.removeAttribute(att.name);
			break;
		}
	});
};

State.prototype.updateChildren = function(from, to) {
	Diff(from.children, to.children, function(node) {
		var key = node.src || node.href;
		if (key) return node.nodeName + '_' + key;
		else return node.outerHTML;
	}).forEach(function(patch) {
		var node = from.children[patch.index];
		switch (patch.type) {
		case Diff.INSERTION:
			from.insertBefore(patch.item, node);
			break;
		case Diff.SUBSTITUTION:
			from.replaceChild(patch.item, node);
			break;
		case Diff.DELETION:
			node.remove();
			break;
		}
	});
};

State.prototype.replace = function(loc) {
	return historyMethod('replace', loc, this);
};

State.prototype.push = function(loc) {
	return historyMethod('push', loc, this);
};

State.prototype.reload = function() {
	debug("reload");
	var prev = this.copy();
	delete prev.pathname;
	delete prev.query;
	delete prev.hash;
	this.referrer = prev;
	return this.run();
};

State.prototype.save = function() {
	return historySave('replace', this);
};

State.prototype.copy = function() {
	return Object.assign(Loc.parse(this), this);
};

State.prototype.router = function() {
	var refer = this.referrer;
	if (!refer.prerender) {
		debug("Default router disabled after non-prerendered referrer");
		return;
	}
	var url = Loc.format(this);
	return Utils.get(url, 500).then(function(client) {
		var doc = Utils.createDoc(client.responseText);
		if (client.status >= 400 && (!doc.body || doc.body.children.length == 0)) {
			throw new Error(client.statusText);
		} else if (!doc) {
			setTimeout(function() {
				document.location = url;
			}, 500);
			throw new Error("Cannot load remote document - redirecting...");
		}
		return doc;
	});
};

function stateTo(state) {
	return {
		href: Loc.format(state),
		data: state.data,
		prerender: false,
		stage: state.stage
	};
}

function stateFrom(from) {
	if (!from || !from.href) return;
	var state = Loc.parse(from.href);
	delete from.href;
	Object.assign(state, from);
	return state;
}

function historySave(method, state) {
	if (!window.history) return false;
	var to = stateTo(state);
	debug("history", method, to);
	window.history[method + 'State'](to, document.title, to.href);
	return true;
}

function historyMethod(method, loc, refer) {
	if (!refer) throw new Error("Missing referrer parameter");
	var copy = Loc.parse(Loc.format(loc));
	if (!Loc.sameDomain(refer, copy)) {
		// eslint-disable-next-line no-console
		if (method == "replace") console.info("Cannot replace to a different origin");
		document.location = Loc.format(copy);
		return P();
	}
	// in case of state.push({data: ..., pathname:...})
	if (typeof loc != "string" && loc.data != null) copy.data = loc.data;
	copy.prerender = refer.prerender;
	copy.referrer = refer;
	debug("run", method, copy);
	return copy.run().then(function(state) {
		historySave(method, state);
	});
}
function historyListener(e) {
	var state = stateFrom(e.state) || Loc.parse();
	debug("history event", e.type, e.state);
	state.referrer = this;
	state.run();
}

