if (process.env.WEBDRIVER) {
	console.info("Running only selenium tests, skipping this one");
	return;
}

var expect = require('expect.js');
var request = require('request');
var express = require('express');
var dom = require('express-dom');

dom.settings.stall = 5000;
dom.settings.allow = 'all';
dom.settings.timeout = 10000;
dom.settings.console = true;

var host = "http://localhost";

describe("Prerendering", function suite() {
	this.timeout(3000);
	var server, port;

	before(function(done) {
		var app = express();
		app.set('views', __dirname + '/public');
		app.get(/\.(json|js|css|png)$/, express.static(app.get('views')));
		app.get(/\/templates\/.+\.html$/, express.static(app.get('views')));
		app.get(/\.html$/, dom().load());


		server = app.listen(function(err) {
			if (err) console.error(err);
			port = server.address().port;
			done();
		});
	});

	after(function(done) {
		server.close();
		done();
	});


	it("should run build but not setup", function(done) {
		request({
			method: 'GET',
			url: host + ':' + port + '/build.html'
		}, function(err, res, body) {
			expect(res.statusCode).to.be(200);
			expect(body).to.contain('<div class="build">1</div>');
			expect(body).to.contain('<div class="setup"></div>');
			done();
		});
	});

	it("should run build and patch but not setup", function(done) {
		request({
			method: 'GET',
			url: host + ':' + port + '/patch.html'
		}, function(err, res, body) {
			expect(res.statusCode).to.be(200);
			expect(body).to.contain('<div class="build">1</div>');
			expect(body).to.contain('<div class="patch">1</div>');
			expect(body).to.contain('<div class="setup"></div>');
			done();
		});
	});

	it("should run route and build", function(done) {
		request({
			method: 'GET',
			url: host + ':' + port + '/route.html?template=build'
		}, function(err, res, body) {
			expect(res.statusCode).to.be(200);
			expect(body).to.contain('<div class="build">0</div>');
			expect(body).to.contain('<div class="setup"></div>');
			done();
		});
	});

	it("should run route and imports", function(done) {
		request({
			method: 'GET',
			url: host + ':' + port + '/route.html?template=import'
		}, function(err, res, body) {
			expect(res.statusCode).to.be(200);
			expect(body).to.contain('data-prerender="true"');
			expect(body).to.contain("I'm built0");
			expect(body).to.contain("your body0");
			done();
		});
	});

	it("should run route and ignore imports", function(done) {
		request({
			method: 'GET',
			url: host + ':' + port + '/route.html?template=import-ignore'
		}, function(err, res, body) {
			expect(res.statusCode).to.be(200);
			expect(body).to.contain('data-prerender="true"');
			expect(body).to.contain("I'm built0");
			expect(body).to.contain('<div class="from-import">77</div>');
			done();
		});
	});

	it("should run route and load scripts in correct order", function(done) {
		request({
			method: 'GET',
			url: host + ':' + port + '/route.html?template=order-scripts'
		}, function(err, res, body) {
			expect(res.statusCode).to.be(200);
			expect(body).to.contain("ABBACCBAC");
			done();
		});
	});

	it("should not load have stylesheets loaded by express-dom prerendering mode anyway", function(done) {
		request({
			method: 'GET',
			url: host + ':' + port + '/route.html?template=stylesheets'
		}, function(err, res, body) {
			expect(res.statusCode).to.be(200);
			expect(body).to.not.contain('<div class="status">squared0</div>');
			done();
		});
	});

	it("should run route and not load already loaded scripts", function(done) {
		request({
			method: 'GET',
			url: host + ':' + port + '/route.html?template=already-loaded'
		}, function(err, res, body) {
			expect(res.statusCode).to.be(200);
			expect(body).to.contain('<div class="mymark">1</div>');
			done();
		});
	});

	it("should reload document during prerendering", function(done) {
		request({
			method: 'GET',
			url: host + ':' + port + '/route.html?template=reload-patch'
		}, function(err, res, body) {
			expect(body).to.contain('data-patchs="2"');
			done();
		});
	});

});

