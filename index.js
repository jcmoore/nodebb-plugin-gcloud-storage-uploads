// adapted from https://github.com/LewisMcMahon/nodebb-plugin-s3-uploads/tree/ab3b762788ba0e05362e3b280b453218ecb2945a

var http = require('http');
var BB = require('bluebird');

var gcloud = require('gcloud');

var Package = require("./package.json");

var uuid = require("uuid").v4;
var fs = require("fs");
var request = require("request");
var path = require("path");
var winston = !module.parent ? null : module.parent.require("winston");
var gm = require("gm");
var im = gm.subClass({imageMagick: true});
var meta = !module.parent ? null : module.parent.require("./meta");
var db = !module.parent ? null : module.parent.require("./database");

var plugin = {}

var _gcs = null;

var _bucketSuffix = (process.env.GCLOUD_BUCKET_SUFFIX || "nodebb-debug");
var _bucketInfix = "";
var _domainRoot = "https://storage.googleapis.com/";

var uploadToGCS = BB.coroutine(function * (filename, context, buffer, callback) {
  var err = null;
  var storage = yield getGCS();
  var bucketName = storage.projectId + "-" + (yield getBucketInfix()) + "-" + _bucketSuffix;

  var bucket = (yield new BB(resolve => storage.createBucket(bucketName, {
    acl: [{
      entity: "allUsers",
      role: "READER",
    }, {
      entity: "allAuthenticatedUsers",
      role: "WRITER",
    }],
    defaultObjectAcl: [{
      entity: "allUsers",
      role: "READER",
    }, {
      entity: "allAuthenticatedUsers",
      role: "WRITER",
    }],
  }, (e, bkt, response) => {
    err = e || err;
    resolve(bkt);
  }))) || storage.bucket(bucketName);

  var file = bucket.file(path.join("uploads", context, filename));

  err = yield new BB(resolve => file.save(buffer, resolve));

  if (err) return callback(err);
  else return callback(null, {
    name: filename,
    url: _domainRoot + path.join(bucket.name, file.name),
  });

});

function getGCS () {
  var url = "/computeMetadata/v1/instance/attributes/gae_project";
  var fallback = process.env.GCLOUD_PROJECT || "";
  if (_gcs) return new BB(resolve => resolve(_gcs));
  else return getMetadata(url, fallback).then(projectId => (_gcs = gcloud.storage({
    projectId: projectId,
  })));
}

function getBucketInfix () {
  var url = "/computeMetadata/v1/instance/attributes/gae_backend_name";
  var fallback = "default";
  if (_bucketInfix) return new BB(resolve => resolve(_bucketInfix));
  else return getMetadata(url, fallback).then(serviceName => (_bucketInfix = serviceName));
}

function getMetadata (url, fallback) {
  return new BB(resolve => !process.env.IS_APP_ENGINE ? resolve(fallback) : http.request({
    hostname: "metadata.google.internal",
    path: url,
    headers: {
      "Metadata-Flavor": "Google",
    },
  }, response => {
    var data = [];
    if (response.statusCode !== 200) {
      response.resume();
      resolve(fallback);
    } else {
      response.on("data", datum => data.push(datum));
      response.on("end", skip => resolve(Buffer.concat(data).toString() || fallback));
      response.on("error", skip => resolve(fallback));
    }
  }).on("error", skip => resolve(fallback)).end());
}

function getContext (data) {
  if (!data.context && data.context !== "") return path.join("uuid", String(data.uid || 0), uuid());
  else return String(data.context).replace(/^\/+/, "");
}

function makeError(err) {
	if (err instanceof Error) {
		err.message = Package.name + " :: " + err.message;
	} else {
		err = new Error(Package.name + " :: " + err);
	}

	winston.error(err.message);
	return err;
}



plugin.activate = function () {
  //_gcs = gcloud.storage();
};

plugin.deactivate = function () {
  _gcs = null;
};

plugin.load = function (params, callback) {
  plugin.activate();
	callback();
};



plugin.uploadImage = function (data, callback) {
  var context = getContext(data);
	var image = data.image;

	if (!image) {
		winston.error("invalid image" );
		return callback(new Error("invalid image"));
	}

	//check filesize vs. settings
	if (image.size > parseInt(meta.config.maximumFileSize, 10) * 1024) {
		winston.error("error:file-too-big, " + meta.config.maximumFileSize );
		return callback(new Error("[[error:file-too-big, " + meta.config.maximumFileSize + "]]"));
	}

	var type = image.url ? "url" : "file";

	if (type === "file") {
		if (!image.path) {
			return callback(new Error("invalid image path"));
		}

		fs.readFile(image.path, function (err, buffer) {
      if (err) callback(makeError(err));
      else uploadToGCS(image.name, context, buffer, callback);
		});
	}
	else {
		var filename = image.url.split("/").pop();

		var imageDimension = parseInt(meta.config.profileImageDimension, 10) || 128;

		// Resize image.
		im(request(image.url), filename)
			.resize(imageDimension + "^", imageDimension + "^")
			.stream(function (err, stdout, stderr) {
				if (err) {
					return callback(makeError(err));
				}

				// This is sort of a hack - We"re going to stream the gm output to a buffer and then upload.
				// See https://github.com/aws/aws-sdk-js/issues/94
				var buf = new Buffer(0);
				stdout.on("data", function (d) {
					buf = Buffer.concat([buf, d]);
				});
				stdout.on("end", function () {
					uploadToGCS(filename, context, buf, callback);
				});
			});
	}
};

plugin.uploadFile = function (data, callback) {
  var context = getContext(data);
	var file = data.file;

	if (!file) {
		return callback(new Error("invalid file"));
	}

	if (!file.path) {
		return callback(new Error("invalid file path"));
	}

	//check filesize vs. settings
	if (file.size > parseInt(meta.config.maximumFileSize, 10) * 1024) {
		winston.error("error:file-too-big, " + meta.config.maximumFileSize );
		return callback(new Error("[[error:file-too-big, " + meta.config.maximumFileSize + "]]"));
	}

	fs.readFile(file.path, function (err, buffer) {
		if (err) callback(makeError(err));
    else uploadToGCS(file.name, context, buffer, callback);
	});
};

module.exports = plugin;
