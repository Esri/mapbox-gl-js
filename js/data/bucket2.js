var Buffer = require('./buffer2');
var util = require('../util/util');
var featureFilter = require('feature-filter');
var StyleLayer = require('../style/style_layer');
var StyleDeclarationSet = require('../style/style_declaration_set');

// TODO add bufferGroup property to attributes, specifying buffers that ought to be
// grouped together

// TODO create shader in constructor, store attribute locations on attribute objects

// TODO add "second element buffer"

// TODO figure out how to send between worker and main thread

function Bucket(options) {
    this.mode = options.mode || Bucket.Mode.TRIANGLES;
    this.elementVertexGenerator = options.elementVertexGenerator;
    this.shader = options.shader;
    this.id = options.layer.id;
    this.buffers = options.buffers;
    this.elementBuffer = options.elementBuffer;
    this.isElementBufferStale = true;

    // TODO send this responsability upwards. This is not the bucket's job.
    this.filter = featureFilter(options.layer.filter);
    this.features = [];

    // Normalize vertex attributes
    this.vertexAttributes = {};
    for (var attributeName in options.vertexAttributes) {
        var attribute = options.vertexAttributes[attributeName];

        attribute.name = attribute.name || attributeName;
        attribute.components = attribute.components || 1;
        attribute.type = attribute.type || Bucket.AttributeTypes.UNSIGNED_BYTE;
        attribute.isStale = true;
        attribute.isFeatureConstant = !(attribute.value instanceof Function);
        attribute.buffer = options.vertexBuffer;
        util.assert(attribute.value !== undefined);

        this.vertexAttributes[attribute.name] = attribute;
    }
}

Bucket.prototype.serialize = function() {
    this.refreshBuffers();

    var serializedVertexAttributes = {};
    this.eachVertexAttribute(function(attribute) {
        serializedVertexAttributes[attribute.name] = util.extend(
            { },
            attribute,
            { value: attribute.isFeatureConstant ? attribute.value : null }
        );
    });

    return {
        id: this.id,
        mode: this.mode,
        vertexAttributes: serializedVertexAttributes,
        elementGroups: this.elementGroups,
        isSerializedMapboxBucket: true,
        shader: this.shader,
        elementLength: this.elementLength,
        vertexLength: this.vertexLength,
        elementBuffer: this.elementBuffer
    }
}

Bucket.prototype.isMapboxBucket = true;

Bucket.prototype.setVertexAttributeValue = function(vertexAttributeName, value) {
    var vertexAttribute = this.vertexAttributes[vertexAttributeName];
    vertexAttribute.value = value || vertexAttribute.value;
    vertexAttribute.isStale = true;
}

Bucket.prototype.eachFeature = function(callback) {
    // TODO deprecate the "this.features" representation
    for (var i = 0; i < this.features.length; i++) {
        callback(this.features[i]);
    }
}

Bucket.prototype.eachVertexAttribute = function(filters, callback) {
    if (arguments.length === 1) {
        callback = filters;
        filters = {};
    }

    for (var attributeName in this.vertexAttributes) {
        var attribute = this.vertexAttributes[attributeName];

        if (filters.isStale !== undefined && filters.isStale !== attribute.isStale) continue;
        if (filters.isFeatureConstant !== undefined && filters.isFeatureConstant !== attribute.isFeatureConstant) continue;

        callback(attribute);
    }
}

Bucket.prototype.refreshBuffers = function() {
    var that = this;

    var staleVertexAttributes = [];
    this.eachVertexAttribute({isStale: true, isFeatureConstant: false}, function(attribute) {
        staleVertexAttributes.push(attribute);
    });

    // Avoid iterating over everything if buffers are up to date
    if (!staleVertexAttributes.length && !this.isElementBufferStale) return;

    // Refresh vertex attribute buffers
    var vertexIndex = 0;
    function vertexCallback(data) {
        for (var j = 0; j < staleVertexAttributes.length; j++) {
            var attribute = staleVertexAttributes[j];
            that.buffers[attribute.buffer].setAttribute(vertexIndex, attribute.name, attribute.value(data));
        }
        elementGroup.vertexLength++;
        return vertexIndex++;
    }

    // Refresh element buffers
    var elementIndex = 0;
    function elementCallback(data) {
        if (that.isElementBufferStale) {
            that.buffers[that.elementBuffer].add(data);
        }
        elementGroup.elementLength++;
        return elementIndex++;
    }

    // Refresh element groups
    // TODO only refresh element groups if element buffer is stale
    var elementGroup = { vertexIndex: 0, elementIndex: 0 };
    var elementGroups = this.elementGroups = [];
    function pushElementGroup(vertexIndexEnd, elementIndexEnd) {
        elementGroup.vertexLength = vertexIndexEnd - elementGroup.vertexIndex;
        elementGroup.elementLength = elementIndexEnd - elementGroup.elementIndex;
        elementGroups.push(elementGroup);
        elementGroup = { vertexIndex: vertexIndexEnd, elementIndex: elementIndexEnd };
    }

    // Iterate over all the features, invoking the other callbacks
    this.eachFeature(function(feature) {
        var featureVertexIndex = vertexIndex;
        var featureElementIndex = elementIndex;
        that.elementVertexGenerator(feature, vertexCallback, elementCallback);
        if (elementGroup.vertexLength > Buffer.elementGroup) {
            pushElementGroup(featureVertexIndex, featureElementIndex);
        }
    });
    pushElementGroup(vertexIndex, elementIndex);

    this.vertexLength = vertexIndex;
    this.elementLength = elementIndex;

    // Mark everything as not stale
    for (var attributeName in this.vertexAttributes) {
        this.vertexAttributes[attributeName].isStale = false;
    }
    this.isElementBufferStale = false;

}

Bucket.Mode = {

    TRIANGLES: {
        name: 'TRIANGLES',
        verticiesPerElement: 3
    }

}

Bucket.AttributeTypes = Buffer.AttributeTypes;

Bucket.ELEMENT_GROUP_VERTEX_LENGTH = 65535;

// TODO maybe move to another file
// TODO simplify parameters
Bucket.createPaintStyleValue = function(layer, constants, zoom, styleName, multiplier) {
    // TODO Dont do this. Refactor style layer to provide this functionality.
    var layer = new StyleLayer(layer, constants);
    layer.recalculate(zoom, []);
    layer.resolvePaint();
    var declarations = new StyleDeclarationSet('paint', layer.type, layer.paint, constants).values();

    var declaration = declarations[styleName];

    if (declaration) {
        var calculate = declaration.calculate({$zoom: zoom});

        function inner(data) {
            return wrap(calculate(data.feature)).map(function(value) {
                return value * multiplier;
            });
        }

        if (calculate.isFeatureConstant) {
            return inner({feature: {}});
        } else {
            return inner;
        }

    } else {
        // TODO classes
        return layer.getPaintProperty(styleName, '');
    }
}

function wrap(value) {
    return Array.isArray(value) ? value : [ value ];
}

module.exports = Bucket;