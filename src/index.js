/**
 * @license
 * Copyright 2018 Google Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

const assert = require('assert');

const createHTMLElementString = require('./lib/create-html-element-string');
const defaultOptions = require('./lib/default-options');
const determineAsValue = require('./lib/determine-as-value');
const doesChunkBelongToHTML = require('./lib/does-chunk-belong-to-html');
const extractChunks = require('./lib/extract-chunks');
const insertLinksIntoHead = require('./lib/insert-links-into-head');

class PreloadPlugin {
  constructor(options) {
    this.options = Object.assign({}, defaultOptions, options);
  }

  addLinks(webpackVersion, compilation, htmlPluginData) {
    assert(webpackVersion in doesChunkBelongToHTML,
        `An invalid webpackVersion was supplied. Supported values: ${Object.keys(doesChunkBelongToHTML)}.`);

    const options = this.options;

    // Bail out early if we're configured to exclude this HTML file.
    if (options.excludeHtmlNames.includes(htmlPluginData.plugin.options.filename)) {
      return htmlPluginData;
    }

    const extractedChunks = extractChunks({
      compilation,
      optionsInclude: options.include,
    });

    const htmlChunks = options.include === 'allAssets' ?
      // Handle all chunks.
      extractedChunks :
      // Only handle chunks imported by this HtmlWebpackPlugin.
      extractedChunks.filter((chunk) => doesChunkBelongToHTML[webpackVersion]({
        chunk,
        compilation,
        htmlAssetsChunks: Object.values(htmlPluginData.assets.chunks),
      }));

    // Flatten the list of files.
    const allFiles = htmlChunks.reduce((accumulated, chunk) => {
      return accumulated.concat(chunk.files);
    }, []);
    const uniqueFiles = new Set(allFiles);
    const filteredFiles = [...uniqueFiles].filter(file => {
      return (
        !this.options.fileWhitelist ||
        this.options.fileWhitelist.some(regex => regex.test(file))
      );
    }).filter(file => {
      return (
        !this.options.fileBlacklist ||
        this.options.fileBlacklist.every(regex => !regex.test(file))
      );
    });
    // Sort to ensure the output is predictable.
    const sortedFilteredFiles = filteredFiles.sort();

    const links = [];
    const publicPath = compilation.outputOptions.publicPath || '';
    for (const file of sortedFilteredFiles) {
      const href = `${publicPath}${file}`;

      const attributes = {
        href,
        rel: options.rel,
      };

      // If we're preloading this resource (as opposed to prefetching),
      // then we need to set the 'as' attribute correctly.
      if (options.rel === 'preload') {
        attributes.as = determineAsValue({
          href,
          optionsAs: options.as,
        });

        // On the off chance that we have an 'href' attribute with a
        // cross-origin URL, set crossOrigin on the <link> to trigger CORS mode.
        // when preloading fonts. (Non-CORS fonts can't be used.)
        if (attributes.as === 'font') {
          attributes.crossorigin = 'anonymous';
        }
      }

      const linkElementString = createHTMLElementString({
        attributes,
        elementName: 'link',
      });
      links.push(linkElementString);
    }

    htmlPluginData.html = insertLinksIntoHead({
      links,
      html: htmlPluginData.html,
    });

    return htmlPluginData;
  }

  apply(compiler) {
    if ('hooks' in compiler) {
      // We're using webpack v4+.
      compiler.hooks.compilation.tap(
          this.constructor.name,
          compilation => {
            // This is set in html-webpack-plugin pre-v4.
            let hook = compilation.hooks.htmlWebpackPluginAfterHtmlProcessing;

            if (!hook) {
              // This is set in html-webpack-plugin v4+.

              // !! As per the docs for v4, I believe the following should work:
              // const HtmlWebpackPlugin = require('html-webpack-plugin');
              // hook = HtmlWebpackPlugin.getHooks(compilation).beforeEmit;
              // !! But when I try that, I get back a AsyncSeriesWaterfallHook
              // !! instance, but tapping into it never leads to the callback
              // !! being run.

              // Only the following will work, if I use the same instance of the
              // require('html-webpack-plugin') used in the main webpack config.
              // For testing purposes, I'm assuming it's being passed in as
              // part of this plugin's constructor.
              hook = this.options.HtmlWebpackPlugin.getHooks(compilation).beforeEmit;
            }

            if (!hook) {
              // If we've gotten here, there might be a plugin ordering issue.
              const error = `Unable to tap into the ` +
                `HtmlWebpackPlugin's callbacks. Make sure to list ` +
                `${this.constructor.name} at some point after ` +
                `HtmlWebpackPlugin in webpack's plugins array.`;
              compilation.errors.push(error);
              return;
            }

            hook.tapAsync(
                this.constructor.name,
                (htmlPluginData, callback) => {
                  // !! We rely on htmlPluginData.assets.chunks.
                  // !! When I run this code in v4, htmlPluginData.assets is
                  // !! undefined.
                  try {
                    callback(null, this.addLinks('v4', compilation, htmlPluginData));
                  } catch (error) {
                    callback(error);
                  }
                }
            );
          }
      );
    } else {
      // We're using webpack pre-v4, which implies that we're also using
      // html-webpack-plugin pre-v4.
      compiler.plugin('compilation', (compilation) => {
        compilation.plugin('html-webpack-plugin-before-html-processing', (htmlPluginData, callback) => {
          try {
            callback(null, this.addLinks('v3', compilation, htmlPluginData));
          } catch (error) {
            callback(error);
          }
        });
      });
    }
  }
}

module.exports = PreloadPlugin;
