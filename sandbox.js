var BB = require('bluebird');

var gcloud = require('gcloud');
var gcs = gcloud.storage(!process.env.GCLOUD_PROJECT ? {} : {
  projectId: process.env.GCLOUD_PROJECT,
});


var setupBucket = BB.coroutine(function * () {
  var err = null;
  var bucketName = gcs.projectId + "-" + (process.env.GCLOUD_BUCKET_SUFFIX || "nodebb-debug");

  var bucket = (yield new BB(resolve => gcs.createBucket(bucketName, {
    acl: [{
      entity: "allUsers",
      role: "READER",
    }],
    defaultObjectAcl: [{
      entity: "allUsers",
      role: "READER",
    }],
  }, (e, bkt, response) => {
    console.log("error", e);
    err = e || err;
    resolve(e ? null : bkt);
  }))) || gcs.bucket(bucketName);

  err = yield new BB(resolve => bucket.file("delete.me").save(new Buffer("please"), resolve));

  console.log("result", err);

  return err;
});

setupBucket();


