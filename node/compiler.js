var Arduino;

var path = require ('path');
var util = require ('util');

var EventEmitter = require('events').EventEmitter;

function ArduinoCompiler (boardsData, platformId, boardId, cpuId) {

	if (!Arduino)
		Arduino = require ('./arduino');

	var platform = boardsData.platform;
	var board = boardsData.boards[boardId];

	var boardBuild = board.build;
	var cpu = board.menu.cpu[cpuId];

	this.boardsData = boardsData;

	this.platformId = platformId;

	this.buildDir = '';

	this.platform = platform;

	this.coreIncludes = [
		boardsData.folders.root + '/cores/' + board.build.core,
		boardsData.folders.root + '/variants/' + board.build.variant
	];

	"upload bootloader build".split (" ").forEach (function (stageName) {
		if (!cpu[stageName])
			return;
		for (var stageKey in cpu[stageName]) {
			board[stageName][stageKey] = cpu[stageName][stageKey];
		}
	});


	// build stage
	var currentStage = "build";

	var conf = JSON.parse (JSON.stringify (platform));
	pathToVar (conf, 'runtime.ide.path', Arduino.instance.runtimeDir);
	pathToVar (conf, 'runtime.ide.version', "1.5.7");

	conf.compiler.path = conf.compiler.path.replaceDict (conf);

	for (var buildK in board.build) {
		conf.build[buildK] = board.build[buildK];
	}

	pathToVar (conf, 'build.arch', platformId.split ('/')[1].toUpperCase ());

	//	console.log ('BUILD', conf.build, platform.recipe.cpp.o.pattern);

	//	The uno.build.board property is used to set a compile-time variable ARDUINO_{build.board}
	//	to allow use of conditional code between #ifdefs. The Arduino IDE automatically generate
	//	a build.board value if not defined. In this case the variable defined at compile time will
	//	be ARDUINO_AVR_UNO.

	this.config = conf;

	this.on ('queue-completed', this.runNext.bind (this));
	// TODO: emit something to arduino
//	this.on ('queue-failed');
}

util.inherits (ArduinoCompiler, EventEmitter);

ArduinoCompiler.prototype.runNext = function (scope) {
	this.runNext.done[scope] = true;
	if (this.runNext.done['core'] && this.runNext.done['libs'] && this.runNext.done['project']) {
		// TODO: anything else
	}
}

ArduinoCompiler.prototype.runNext.done = {};

ArduinoCompiler.prototype.enqueueCmd = function (scope, cmdLine) {
	if (!this.enqueueCmd.queue[scope])
		this.enqueueCmd.queue[scope] = {length: 0, pos: -1, running: false};
	var thisQueue = this.enqueueCmd.queue[scope];
	thisQueue[thisQueue.length++] = cmdLine;
	this.runCmd (scope);
	console.log (cmdLine);
}

ArduinoCompiler.prototype.enqueueCmd.queue = {};

ArduinoCompiler.prototype.runCmd = function (scope) {
	var thisQueue = this.enqueueCmd.queue[scope];
	if (thisQueue.pos + 1 === thisQueue.length) {
		// TODO: emit done
		this.emit ('queue-completed', scope);
		return;
	}
	if (!thisQueue.running && thisQueue.pos + 1 < thisQueue.length) {
		thisQueue.running = true;
		(function cb (err, done) {
			if (err) {
				this.emit ('queue-failed', scope, err);
				return;
			}
			thisQueue.pos ++;
			this.emit ('queue-progress', scope, thisQueue.pos, thisQueue.length);
			this.runCmd (scope);
		}).bind (this);
		// TODO: actual run
	}

}

ArduinoCompiler.prototype.getConfig = function () {
	// speed doesn't matter here
	return JSON.parse (JSON.stringify (this.config));
}

ArduinoCompiler.prototype.setLibNames = function (libNames) {
	this.libNames = libNames;
	// TODO: start lib compilation
	if (!this.libIncludes)
		this.libIncludes = [];
	if (!this.libCompile)
		this.libCompile = {};
	// TODO: analyse source
	var self = this;
	libNames.forEach ((function (libName) {
		var libMeta = Arduino.instance.findLib (this.platformId, libName);
		if (!libMeta || !libMeta.root) {
			console.log ('cannot find library', libName);
		}
		this.libCompile[libName] = libMeta;
		// libIncludes.push (libDir.root);
	}).bind (this));

	// we can compile libs, core and current sources at same time
	// in a ideal case this is 3x speedup
	// also, core do not need a rebuild

	var conf = this.getConfig ();

	// console.log (Object.keys (this.libCompile));

	for (var libName in this.libCompile) {
		var libMeta = this.libCompile[libName];
		this.libIncludes.push (libMeta.root);
		var libIncludes = [""].concat (this.coreIncludes).join (" -I")
		+ ' -I' + libMeta.root
		+ ' -I' + libMeta.root + '/utility';
		for (var libSrcFile in libMeta.files) {
			if (!libSrcFile.match (/\.c(pp)?$/))
				continue;
			var ext = libSrcFile.substring (libSrcFile.lastIndexOf ('.')+1);
			conf.source_file = path.join (libMeta.root, libSrcFile);
			// TODO: build dir
//			console.log (libSrcFile);
			conf.object_file = path.join (this.buildDir, libName, libSrcFile + '.o');
			conf.includes    = libIncludes;
			var compileCmd   = this.platform.recipe[ext].o.pattern.replaceDict (conf);
			console.log ('[libs]', libName, '>', path.join (libName, libSrcFile));
			this.enqueueCmd ('libs', compileCmd);
			if (Arduino.instance.verbose)
				console.log (compileCmd);

		}
	}

	this.emit ('includes-set');
}

ArduinoCompiler.prototype.setCoreFiles = function (err, coreFileList) {
	if (err) {
		console.log (err);
		this.error = 'core.files';
		return;
	}

	var conf = this.getConfig ();

	coreFileList.forEach ((function (srcFile) {
		var ext = srcFile.substring (srcFile.lastIndexOf ('.')+1);
		var localName = srcFile.substring (srcFile.lastIndexOf ('/')+1);
		conf.source_file = srcFile;
		// TODO: build dir
		conf.object_file = path.join (this.buildDir, localName + '.o');
		conf.includes = [""].concat (this.coreIncludes).join (" -I");
		var compileCmd = this.platform.recipe[ext].o.pattern.replaceDict (conf);
		console.log ('[core]', srcFile);
		this.enqueueCmd ('core', compileCmd);
		if (Arduino.instance.verbose)
			console.log (compileCmd);
	}).bind (this));

	// after all, we need to make core.a file
}

ArduinoCompiler.prototype.processProjectFiles = function () {

	var conf = this.getConfig ();

	this.projectFiles.forEach ((function (srcFile) {

		var ext = srcFile.substring (srcFile.lastIndexOf ('.') + 1);
		conf.source_file = srcFile;
		// TODO: build dir
		conf.object_file = srcFile + '.o';
		var includes = [""].concat (this.coreIncludes, this.libIncludes).join (" -I");
		conf.includes = includes;

		var compileCmd = this.platform.recipe[ext].o.pattern.replaceDict (conf);
		console.log ('[project]', srcFile);
		this.enqueueCmd ('project', compileCmd);
		if (Arduino.instance.verbose)
			console.log (compileCmd);
	}).bind (this));

}

ArduinoCompiler.prototype.setProjectFiles = function (err, files, dontCompile) {
	if (err) {
		console.log (err);
		return;
	}

	if (!this.projectFiles)
		this.projectFiles = [];
	this.projectFiles = this.projectFiles.concat (files);

	if (dontCompile)
		return;

	if (!this.libIncludes) {
		this.on ('includes-set', this.processProjectFiles.bind (this));
	} else {
		this.processProjectFiles();
	}
}

String.prototype.replaceDict = function (conf) {
	return this.replace (/{(\w+\.)*\w+}/g, function (match) {
		var varPath = match.substring (1, match.length - 1);
		var result = pathToVar (conf, varPath);
		if (result === undefined)
			throw "no interpolation found for "+varPath
			return result;
	})
}

function pathToVar (root, varPath, value) {
	varPath.split ('.').forEach (function (chunk, index, chunks) {
		// pathChunks[index] = chunk;
		var newRoot = root[chunk];
		if (index === chunks.length - 1 && value !== undefined) {
			root[chunk] = value;
		} else if (!newRoot) {
			root[chunk] = {};
			newRoot = root[chunk];
		}
		root = newRoot;
	});
	return root;
}

module.exports = ArduinoCompiler;