"use strict";

const NodeHelper = require("node_helper");
const request = require("request");
const fs = require("fs");

function shuffle(a) {
  var source = a.slice(0);
  var result = [];
  var i, j;

  for (i = a.length; i > 0; --i) {
    j = Math.floor(Math.random() * i);
    result.push(source[j]);
    source[j] = source[i - 1];
  }

  return result;
}

function pick(a) {
  if (Array.isArray(a)) {
    return a[Math.floor(Math.random() * a.length)];
  } else {
    return a;
  }
}

module.exports = NodeHelper.create({
  start: function() {
    var self = this;

    console.log(`Starting node helper for: ${self.name}`);
    self.cache = {};
    self.firetv = JSON.parse(fs.readFileSync(`${__dirname}/firetv.json`));
    self.chromecast = JSON.parse(fs.readFileSync(`${__dirname}/chromecast.json`));
  },

  socketNotificationReceived: function(notification, payload) {
    var self = this;

    if (notification === "FETCH_WALLPAPERS") {
      self.fetchWallpapers(payload);
    }
  },

  fetchWallpapers: function(config) {
    var self = this;
    var cache_key = self.getCacheKey(config);
    var url;
    var method = "GET";
    var body = undefined;

    if (cache_key in self.cache &&
        config.maximumEntries <= self.cache[cache_key].images.length &&
        Date.now() < self.cache[cache_key].expires)
    {
      self.sendWallpaperUpdate(config);
      return;
    }

    config.source = pick(config.source);
    var source = config.source.toLowerCase();
    if (source === "firetv") {
      self.sendSocketNotification("WALLPAPERS", {
        "source": config.source,
        "orientation": config.orientation,
        "images": shuffle(self.firetv.images).slice(0, config.maximumEntries),
      });
      return;
    } else if (source === "chromecast") {
      self.sendSocketNotification("WALLPAPERS", {
        "source": config.source,
        "orientation": config.orientation,
        "images": shuffle(self.chromecast).slice(0, config.maximumEntries),
      });
      return;
    } else if (source.startsWith("http://") || source.startsWith("https://")) {
      self.sendSocketNotification("WALLPAPERS", {
        "source": config.source,
        "orientation": config.orientation,
        "images": [{"url": config.source}],
      });
      return;
    } else if (source.startsWith("/r/")) {
      self.request(config, {
        url: `https://www.reddit.com${config.source}/hot.json`,
        headers: {
          "user-agent": "MagicMirror:MMM-Wallpaper:v1.0 (by /u/kolbyhack)"
        },
      });
    } else if (source === "pexels") {
      self.request(config, {
        url: "https://api.pexels.com/v1/search?query=" + config.pexels_search,
        headers: {
          Authorization: config.pexels_key
        },
      });
    } else if (source.startsWith("icloud:")) {
      self.iCloudState = "webstream";
      self.request(config, {
        method: "POST",
        url: `https://p04-sharedstreams.icloud.com/${config.source.substring(7)}/sharedstreams/webstream`,
        body: '{"streamCtag":null}',
      });
    } else if (source.startsWith("flickr-group:")) {
      self.request(config, {
        url: `https://api.flickr.com/services/feeds/groups_pool.gne?format=json&id=${config.source.substring(13)}`,
      });
    } else if (source.startsWith("flickr-user:")) {
      self.request(config, {
        url: `https://api.flickr.com/services/feeds/photos_public.gne?format=json&id=${config.source.substring(12)}`,
      });
    } else if (source.startsWith("flickr-user-faves:")) {
      self.request(config, {
        url: `https://api.flickr.com/services/feeds/photos_faves.gne?format=json&id=${config.source.substring(18)}`,
      });
    } else if (source.startsWith("lightroom:")) {
      self.request(config, {
        url: `https://${config.source.substring(10)}`,
      });
    } else {
      self.request(config, {
        url: `https://www.bing.com/HPImageArchive.aspx?format=js&idx=0&n=${config.maximumEntries}`,
      });
    }
  },

  request: function(config, params) {
    var self = this;

    if (!("headers" in params)) {
      params.headers = {};
    }

    if (!("cache-control" in params.headers)) {
      params.headers["cache-control"] = "no-cache";
    }

    request(params,
      function(error, response, body) {
        if (error) {
          self.sendSocketNotification("FETCH_ERROR", { error: error });
          return console.error(` ERROR - MMM-Wallpaper: ${error}`);
        }

        if (response.statusCode < 400 && body.length > 0) {
          self.processResponse(response, body, config);
        }
      }
    );
  },

  sendWallpaperUpdate: function(config) {
    var self = this;
    var cache_key = self.getCacheKey(config);

    self.sendSocketNotification("WALLPAPERS", {
      "source": config.source,
      "orientation": config.orientation,
      "images": self.cache[cache_key].images,
    });
  },

  processResponse: function(response, body, config) {
    var self = this;
    var cache_key = self.getCacheKey(config);
    var images;

    var source = config.source.toLowerCase();
    if (source.startsWith("/r/")) {
      images = self.processRedditData(config, JSON.parse(body));
    } else if (source.startsWith("icloud:")) {
      images = self.processiCloudData(response, JSON.parse(body), config);
    } else if (source.startsWith("flickr-")) {
      images = self.processFlickrData(config, body);
    } else if (source === "pexels") {
      images = self.processPexelsData(config, JSON.parse(body));
    } else if (source.startsWith("lightroom:")) {
      images = self.processLightroomData(config, body);
    } else {
      images = self.processBingData(config, JSON.parse(body));
    }

    if (images.length === 0) {
      return;
    }

    self.cache[cache_key] = {
      "expires": Date.now() + config.updateInterval * 0.9,
      "images": images,
    };

    self.sendWallpaperUpdate(config);
  },

  processPexelsData: function (config, data) {
    var self = this;
    var width = (config.orientation === "vertical") ? 1080 : 1920;
    var height = (config.orientation === "vertical") ? 1920 : 1080;
    var suffix = "_" + width + "x" + height + ".jpg";
    var orientation

    if (config.orientation === "vertical") {
      orientation = "portrait"
    } else {
      orientation = "landscape"
    }

    var images = [];
    for (var i in data.photos) {
      var image = data.photos[i];

      images.push({
        url: image.src[orientation],
        caption: "Photographer:" + image.photographer,
      });
    }

    return images;
  },

  processBingData: function(config, data) {
    var self = this;
    var width = (config.orientation === "vertical") ? 1080 : 1920;
    var height = (config.orientation === "vertical") ? 1920 : 1080;
    var suffix = "_" + width + "x" + height + ".jpg";

    var images = [];
    for (var i in data.images) {
      var image = data.images[i];

      images.push({
        url: `https://www.bing.com${image.urlbase}${suffix}`,
        caption: image.copyright,
      });
    }

    return images;
  },

  processRedditData: function(config, data) {
    var self = this;

    var images = [];
    for (var i in data.data.children) {
      var post = data.data.children[i];

      if (post.kind === "t3"
          && !post.data.pinned
          && !post.data.stickied
          && post.data.post_hint === "image"
          && (config.nsfw || !post.data.over_18)) {
        var variants = post.data.preview.images[0].resolutions.slice(0);

        variants.push(post.data.preview.images[0].source);
        variants.map((v) => { v.url = v.url.split("&amp;").join("&"); return v; });
        variants.sort((a, b) => { return a.width * a.height - b.width * b.height; });

        images.push({
          url: post.data.url.replace("&amp;", "&"),
          caption: post.data.title,
          variants: variants,
        });

        if (images.length === config.maximumEntries) {
          break;
        }
      }
    }

    return images;
  },

  processiCloudData: function(response, body, config) {
    var self = this;
    var album = config.source.substring(7);
    var images = [];

    if (self.iCloudState === "webstream") {
      if (response.statusCode === 330) {
        self.iCloudHost = body["X-Apple-MMe-Host"];
        self.request(config, {
          method: "POST",
          url: `https://${self.iCloudHost}/${album}/sharedstreams/webstream`,
          body: '{"streamCtag":null}'
        });
      } else if (response.statusCode === 200) {
        self.iCloudPhotos = shuffle(body.photos).filter((p) => p != null && p.derivatives.mediaAssetType !== "video").slice(0, config.maximumEntries);
        self.iCloudState = "webasseturls";

        var photoGuids = self.iCloudPhotos.map((p) => { return p.photoGuid; });
        self.request(config, {
          method: "POST",
          url: `https://${self.iCloudHost}/${album}/sharedstreams/webasseturls`,
          body: JSON.stringify({"photoGuids": photoGuids}),
        });
      }
    } else if (self.iCloudState === "webasseturls") {
      for (var checksum in body.items) {
        var p = body.items[checksum];
        var loc = body.locations[p.url_location];
        var host = loc.hosts[Math.floor(Math.random() * loc.hosts.length)];

        for (var i in self.iCloudPhotos) {
          for (var d in self.iCloudPhotos[i].derivatives) {
            var m = self.iCloudPhotos[i].derivatives[d];
            if (m.checksum === checksum) {
              m.url = `${loc.scheme}://${host}${p.url_path}`;
              break;
            }
          }
        }
      }

      images = self.iCloudPhotos.map((p) => {
        var result = {
          url: null,
          caption: p.caption,
          variants: [],
        };

        for (var i in p.derivatives) {
          var d = p.derivatives[i];

          if (+d.width > 0) {
            result.variants.push({
              url: d.url,
              width: +d.width,
              height: +d.height,
            });
          }
        }

        result.variants.sort((a, b) => { return a.width * a.height - b.width * b.height; });
        result.url = result.variants[result.variants.length - 1].url;

        return result;
      });
    }

    return images;
  },

  processFlickrData: function(config, body) {
    var self = this;
    var data = JSON.parse(body.replace(/^[^{]*/, "").replace(/[^}]*$/, ""));

    var images = [];
    for (var i in data.items) {
      var post = data.items[i];

      images.push({
        url: post.media.m.replace(/_m\./, "_h."),
        caption: post.title,
      });

      if (images.length === config.maximumEntries) {
        break;
      }
    }

    return images;
  },

  processLightroomData: function(config, body) {
    var self = this;
    var data = shuffle(body.match(/data-srcset="[^"]+/g));

    var images = [];
    for (var i in data) {
      var variants = data[i].substring(13).split(",");
      var result = {
        url: null,
        variants: [],
      };

      for (var i in variants) {
        var d = variants[i].split(" ");
        var width = Number.parseInt(d[1]);

        if (width > 0) {
          result.variants.push({
            url: d[0],
            width: width,
            height: 1,
          });
        }
      }

      if (result.variants.length === 0) {
        continue;
      }

      result.variants.sort((a, b) => { return a.width * a.height - b.width * b.height; });
      result.url = result.variants[result.variants.length - 1].url;
      images.push(result);

      if (images.length === config.maximumEntries) {
        break;
      }
    }

    return images;
  },

  getCacheKey: function(config) {
    return config.source + "::" + config.orientation;
  },
});
