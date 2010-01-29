// ========================================================================
// Copyright (c) 2008-2009, Metaweb Technologies, Inc.
// All rights reserved.
// 
// Redistribution and use in source and binary forms, with or without
// modification, are permitted provided that the following conditions
// are met:
//     * Redistributions of source code must retain the above copyright
//       notice, this list of conditions and the following disclaimer.
//     * Redistributions in binary form must reproduce the above
//       copyright notice, this list of conditions and the following
//       disclaimer in the documentation and/or other materials provided
//       with the distribution.
// 
// THIS SOFTWARE IS PROVIDED BY METAWEB TECHNOLOGIES AND CONTRIBUTORS
// ``AS IS'' AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
// LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
// A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL METAWEB
// TECHNOLOGIES OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT,
// INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING,
// BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS
// OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND
// ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR
// TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE
// USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH
// DAMAGE.
// ========================================================================


/*
**  Automatic reconciliation
*/
var manualQueue = {};
var automaticQueue = new AutomaticQueue();


/** @constructor
  * @param {Array.<tEntity>=} initialValues
  */
function AutomaticQueue(initialValues) {
    /** @const
        @type {Array.<tEntity>}*/
    this.internalQueue = initialValues || [];
    /** @type {number} */
    this.length = this.internalQueue.length;
}

/** @param {tEntity} entity
  */
AutomaticQueue.prototype.push = function(entity) {
    entity['/rec_ui/rec_begun'] = true;
    this.length++;
    this.internalQueue.push(entity);
}

/** @return {tEntity} */
AutomaticQueue.prototype.peek = function() {
    return this.internalQueue[0];
}

/** @return {tEntity|undefined} */
AutomaticQueue.prototype.shift = function() {
    if (this.length === 0) 
        return undefined;
    this.length--;
    return this.internalQueue.shift();
}

function beginAutoReconciliation() {
    $(".nowReconciling").show();
    $(".notReconciling").hide();
    $("#gettingInput").remove();
    autoReconcile();
}

function finishedAutoReconciling() {
    $(".nowReconciling").hide();
    $('.notReconciling').show();
}

function autoReconcile() {
    if (automaticQueue.length == 0) {
        finishedAutoReconciling();
        return;
    }
    updateUnreconciledCount();
    getCandidates(automaticQueue.peek(), autoReconcileResults, function(){automaticQueue.shift();autoReconcile();});
}

/** @param {!tEntity} entity
    @param {boolean=} typeless
*/
function constructReconciliationQuery(entity, typeless) {
    var query = {}
    var headers = entity["/rec_ui/headers"];
    for (var i = 0; i < headers.length; i++) {
        var prop = headers[i];
        if (prop.charAt(0) != "/") continue;
        var parts = prop.split(":");
        $.each($.makeArray(entity.getChainedProperty(prop)),function(j, value) {
            var slot = query;
            if (value == undefined || value == "")
                return;
            if (parts.length === 1){
                slot[prop] = slot[prop] || [];
                slot[prop][j] = constructQueryPart(value);
                return;
            }
            slot[parts[0]]    = slot[parts[0]]    || [];
            slot[parts[0]][j] = slot[parts[0]][j] || {};
            slot = slot[parts[0]][j];
            $.each(parts.slice(1,parts.length-1), function(k,part) {
                slot[part] = slot[part] || {};
                slot = slot[part];
            });
            var lastPart = parts[parts.length-1];
            slot[lastPart] = constructQueryPart(value);
        })        
    }
    if (typeless || !query['/type/object/type'])
        query['/type/object/type'] = ['/common/topic'];
    query = cleanup(query);
    entity['/rec_ui/recon_query'] = query;
    return query;
    
    function constructQueryPart(value) {
        if (value.id != undefined && value.id != "" && value.id != "None")
            return {"id":value.id, "name":value["/type/object/name"]}
        if (value['/rec_ui/id'] !== undefined)
            return $.makeArray(value["/type/object/name"])[0];
        return value;
    }
    
    /* Removes undefined values, nulls, empty lists, empty objects,
       and collapses singleton arrays down to their single values
       to better feed the reconciliation service.  */
    function cleanup(value) {
        switch(getType(value)){
        case "array": 
            value = $.map(value, function(v) {
                return cleanup(v);
            });
            if (value.length === 0)
                return null;
            if (value.length === 1)
                return value[0];
            return value;
        case "object":
            var clone = {};
            for (var key in value) {
                var v = cleanup(value[key]);
                if (v === null || v === undefined)
                    continue;
                clone[key] = v;
            }
            if (isObjectEmpty(clone))
                return null;
            return clone;
        default:
            return value;
        }
    }
}

/**
 *  @param {tEntity} entity
 *  @param {function(tEntity)} callback
 *  @param {function(...)} onError
 *  @param {boolean=} typeless
 */
function getCandidates(entity, callback, onError,typeless) {
    function handler(results) {
        entity.reconResults = results;
        callback(entity);
    }
    var defaultLimit = 4;
    var limit = defaultLimit;
    if (entity.reconResults)
        limit = entity.reconResults.length * 2;
    if (!entity.typelessRecon && typeless){
        entity.typelessRecon = true;
        limit = defaultLimit;
    }
    var query = constructReconciliationQuery(entity,typeless);
    getJSON(reconciliation_url + "query?jsonp=?", {q:JSON.stringify(query), limit:limit}, handler, onError);
}

/** @param {tEntity} entity */
function autoReconcileResults(entity) {
    automaticQueue.shift();
    // no results, set to None:
    if(entity.reconResults.length == 0) {
        if (!entity.typelessRecon)
            getCandidates(entity,autoReconcileResults,function(){automaticQueue.shift();autoReconcile();},true);
        
        entity.reconcileWith("None", true);
        warn("No candidates found for the object:");
        warn(entity);
        addColumnRecCases(entity);
    }        
    // match found:
    else if(entity.reconResults[0]["match"] == true) {
        var matchedResult = entity.reconResults[0];
        if (require_exact_name_match && !Arr.contains($.makeArray(entity['/type/object/name']),$.makeArray(matchedResult.name)[0])) {
            addToManualQueue(entity);
        }
        else {
            entity.reconcileWith(matchedResult.id, true);
            canonicalizeFreebaseId(entity);
            entity["/rec_ui/freebase_name"] = matchedResult.name;
            addColumnRecCases(entity);
        }
    }
    else
        addToManualQueue(entity)
    autoReconcile();
}