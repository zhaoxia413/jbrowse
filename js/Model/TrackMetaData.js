dojo.declare( 'JBrowse.Model.TrackMetaData', null,
/**
 * @lends JBrowse.Model.TrackMetaData.prototype
 */
{
    /**
     * Data store for track metadata, supporting faceted
     * (parameterized) searching.  Keeps all of the track metadata,
     * and the indexes thereof, in memory.
     * @constructs
     * @param args.trackConfigs {Array} array of track configuration
     */
    constructor: function( args ) {

        // set up our facet name discrimination: what facets we will
        // actually provide search on
        this._filterFacet = args.filterFacets || function() {return true;};

        // set up our onReady callbacks
        if( ! dojo.isArray( args.onReady ) ){
            this.onReadyFuncs = args.onReady ? [ args.onReady ] : [];
        } else {
            this.onReadyFuncs = dojo.clone(args.onReady);
        }

        // fetch and index all the items from each of the stores
        var stores_fetched_count = 0;
        dojo.forEach( args.metadataStores, function(store) {
            store.fetch({
                scope: this,
                onComplete: Util.debugHandler( this, function(items) {
                    // build our indexes
                    this._indexItems( store, items );

                    // if this is the last store to be fetched, call
                    // our onReady callbacks
                    if( ++stores_fetched_count == args.metadataStores.length ) {
                        this.ready = true;
                        dojo.forEach( this.onReadyFuncs, function(f) {
                                          f.call( this, this );
                                      }, this );
                        this.onReadyFuncs = [];
                    }
                })
            });
        },this);
     },

    _indexItems: function( store, items ) {

        // get our (filtered) list of facets we will index for
        var seen = {};
        var facets = this.facets =
            dojo.filter( ( this.facets || [] ).concat( store.getAttributes(items[0])),
                         function(facetName) {
                             var take = this._filterFacet(facetName) && !seen[facetName];
                             seen[facetName] = true;
                             return take;
                         },
                         this
                       );

        // initialize our indexes if necessary
        this.identIndex = this.identIndex || {};
        this.facetIndexes = this.facetIndexes || { itemCount: 0, bucketCount: 0, byName: {} };
        dojo.forEach( facets, function(facet) {
            if( ! this.facetIndexes.byName[facet] ) {
                this.facetIndexes.bucketCount++;
                this.facetIndexes.byName[facet] = { itemCount: 0, bucketCount: 0, byValue: {} };
            }
        }, this);

        // put each of the items into our indexes
        dojo.forEach( items, function( item ) {

            //convert the item into a uniform data format of plain objects
            item = (function(){
                var newitem = {};
                dojo.forEach(store.getAttributes(item), function(attr) {
                    newitem[attr] = store.getValue(item,attr);
                });
                return newitem;
            }).call(this);

            this.identIndex[ this.getIdentity(item) ] = item;

            this.facetIndexes.itemCount++;
            dojo.forEach( facets, function( facet ) {
                var value = this.getValue( item, facet, undefined );
                if( typeof value == 'undefined' )
                    return;
                var facetValues = this.facetIndexes.byName[facet];
                var bucket = facetValues.byValue[value];
                if( !bucket ) {
                    bucket = facetValues.byValue[value] = { itemCount: 0, items: [] };
                    facetValues.bucketCount++;
                }
                bucket.itemCount++;
                bucket.items.push(item);
            },this);
        }, this);

        this.facetIndexes.facetRank = this.facets.sort(dojo.hitch(this,function(a,b){
            return this.facetIndexes.byName[b].bucketCount - this.facetIndexes.byName[a].bucketCount;
        }));

        console.log(this.facetIndexes);
    },

    /**
     * Get an array of the text names of the facets that are defined
     * in this track metadata.
     * @param callback {Function} called as callback( [facet,facet,...] )
     */
    getFacets: function( callback ) {
        return this.facets;
    },

    /**
     * Get an Array of the distinct values for a given facet name.
     * @param facetName {String} the facet name
     * @returns {Array} distinct values for that facet
     */
    getFacetValues: function( facetName ) {
        var index = this.facetIndexes.byName[facetName];
        if( !index )
            return [];

        return dojof.keys( index.byValue );
    },

    /**
     * Add a callback to be called when this store is ready (i.e. loaded).
     */
    onReady: function( callback ) {
        if( this.ready ) {
            callback.call( this, this );
        }
        else {
            this.onReadyFuncs.push( callback );
        }
    },

    // dojo.data.api.Read support

    getValue: function( i, attr, defaultValue ) {
        var v = i[attr];
        return typeof v == 'undefined' ? defaultValue : v;
    },
    getValues: function( i, attr ) {
        var a = [ i[attr] ];
        return typeof a[0] == 'undefined' ? [] : a;
    },

    getAttributes: function(item)  {
        return dojof.keys( item );
    },

    hasAttribute: function(item,attr) {
        return item.hasOwnProperty(attr);
    },

    containsValue: function(item, attribute, value) {
        return item[attribute] == value;
    },

    isItem: function(item) {
        return typeof item == 'object' && typeof item[name] == 'string';
    },

    isItemLoaded: function() {
        return true;
    },

    loadItem: function( args ) {
    },

    // used by the dojo.data.util.simpleFetch mixin to implement fetch()
    _fetchItems: function( keywordArgs, findCallback, errorCallback ) {
        if( ! this.ready ) {
            this.onReady( dojo.hitch( this, '_fetchItems', keywordArgs, findCallback, errorCallback ) );
            return;
        }

        var query = dojo.clone( keywordArgs.query || {} );
        var textFilter = query.text;
        delete query.text;

        var results;

        // if we don't actually have any facets specified in the
        // query, the results are just all the items
        if( ! dojo.some( dojof.values(query), function(q){ return q.length > 0;}) ) {
            results = dojof.values( this.identIndex );
        }
        else {
            // start with an initial set of items that have the desired
            // value for the most specific (smallest avg index bucket
            // size) facet that was specified
            results = (function() {
                           var highestRankedFacet,
                               queryValues = [],
                               index;
                           dojo.some( this.facetIndexes.facetRank, function(facetName) {
                                          if( query[facetName] ) {
                                              highestRankedFacet = facetName;
                                              queryValues = query[highestRankedFacet];
                                              index = this.facetIndexes.byName[highestRankedFacet];
                                              return queryValues.length > 0;
                                          }
                                          return false;
                                      },this);

                           delete query[highestRankedFacet];

                           var set = [];
                           dojo.forEach( queryValues, function(val) {
                                             set.push( index.byValue[val] || [] );
                                         },this);
                           return set;
                       }).call(this);

            // and filter this starting set for the other facets
            dojo.forEach( dojof.keys(query), function(facetName) {
                              var desired_values = query[facetName] || [];
                              if( desired_values.length )
                                  return;
                              results = dojo.filter(results, function(item) {
                                                        var value = this.getValue(item,facetName);
                                                        return dojo.some( desired_values, function(desired) {
                                                                              return desired == value;
                                                                          },this);
                                                    },this);
                          },this);
        }

        // TODO: filter with the text filter, if we have it

        // and finally, hand them to the finding callback
        findCallback(results,keywordArgs);
    },

    getFeatures: function() {
        return {
	    'dojo.data.api.Read': true,
	    'dojo.data.api.Identity': true
	};
    },
    close: function() {},

    getLabel: function(i) {
        return this.getValue(i,'key',undefined);
    },
    getLabelAttributes: function(i) {
        return ['key']; },

    // dojo.data.api.Identity support
    getIdentityAttributes: function() {
        return ['label'];
    },
    getIdentity: function(i) {
        return this.getValue(i, 'label', undefined);
    },
    fetchItemByIdentity: function(id) {
        return this.identIndex[id];
    }
});
dojo.require('dojo.data.util.simpleFetch');
dojo.extend( JBrowse.Model.TrackMetaData, dojo.data.util.simpleFetch );