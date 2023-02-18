﻿varying vec2 vUv;

uniform sampler2D velocityTexture;

uniform sampler2D depthTexture;
uniform sampler2D lastDepthTexture;

uniform sampler2D normalTexture;
uniform sampler2D lastNormalTexture;

uniform float blend;
uniform bool constantBlend;
uniform bool fullAccumulate;
uniform vec2 invTexSize;

uniform mat4 projectionMatrix;
uniform mat4 projectionMatrixInverse;
uniform mat4 cameraMatrixWorld;
uniform mat4 prevViewMatrix;
uniform mat4 prevCameraMatrixWorld;
uniform vec3 cameraPos;
uniform vec3 prevCameraPos;

#define EPSILON 0.00001

#include <packing>
#include <reproject>

void main() {
    vec4 depthTexel;
    float depth;
    vec2 uv;

    getDepthAndUv(depth, uv, depthTexel);

    if (dot(depthTexel.rgb, depthTexel.rgb) == 0.0) {
#ifdef neighborhoodClamping
    #pragma unroll_loop_start
        for (int i = 0; i < textureCount; i++) {
            gOutput[i] = textureLod(inputTexture[i], vUv, 0.0);
        }
    #pragma unroll_loop_end
#else
        discard;
#endif
        return;
    }

    vec4 inputTexel[textureCount];
    vec4 accumulatedTexel[textureCount];

#pragma unroll_loop_start
    for (int i = 0; i < textureCount; i++) {
        inputTexel[i] = textureLod(inputTexture[i], vUv, 0.0);
        inputTexel[i].rgb = transformColor(inputTexel[i].rgb);
    }
#pragma unroll_loop_end

    vec4 normalTexel = textureLod(normalTexture, uv, 0.);
    vec3 worldNormal = unpackRGBToNormal(normalTexel.xyz);
    worldNormal = normalize((vec4(worldNormal, 1.) * viewMatrix).xyz);
    vec3 worldPos = screenSpaceToWorldSpace(uv, depth, cameraMatrixWorld);

    vec2 reprojectedUvDiffuse = vec2(-10.0);
    vec2 reprojectedUvSpecular[textureCount];

    vec2 reprojectedUv;

#pragma unroll_loop_start
    for (int i = 0; i < textureCount; i++) {
        // specular
        if (reprojectSpecular[i] && inputTexel[i].a != 0.0) {
            reprojectedUvSpecular[i] = getReprojectedUV(uv, depth, worldPos, worldNormal, inputTexel[i].a);
        } else {
            reprojectedUvSpecular[i] = vec2(-1.0);
        }

        // diffuse
        if (reprojectedUvDiffuse.x == -10.0 && reprojectedUvSpecular[i].x < 0.0) {
            reprojectedUvDiffuse = getReprojectedUV(uv, depth, worldPos, worldNormal, 0.0);
        }

        // choose which UV coordinates to use for reprojecion
        reprojectedUv = reprojectedUvSpecular[i].x >= 0.0 ? reprojectedUvSpecular[i] : reprojectedUvDiffuse;

        // check if any reprojection was successful
        if (reprojectedUv.x < 0.0) {  // invalid UV
            // reprojection was not successful -> reset to the input texel
            accumulatedTexel[i] = vec4(inputTexel[i].rgb, 1.0);
        } else {
            // reprojection was successful -> accumulate
            accumulatedTexel[i] = sampleReprojectedTexture(accumulatedTexture[i], reprojectedUv, catmullRomSampling[i]);
            accumulatedTexel[i].rgb = transformColor(accumulatedTexel[i].rgb);

            if (dot(inputTexel[i].rgb, inputTexel[i].rgb) == 0.0) {
                inputTexel[i].rgb = accumulatedTexel[i].rgb;
            } else {
                accumulatedTexel[i].a++;  // add one more frame
            }

#ifdef neighborhoodClamping
            clampNeighborhood(inputTexture[i], accumulatedTexel[i].rgb, inputTexture[i], inputTexel[i].rgb);
#endif
        }
    }
#pragma unroll_loop_end

    vec2 deltaUv = vUv - reprojectedUv;
    bool didMove = dot(deltaUv, deltaUv) > 0.0;
    float maxValue = (!fullAccumulate || didMove) ? blend : 1.0;

    vec3 outputColor;
    float temporalReprojectMix;

#pragma unroll_loop_start
    for (int i = 0; i < textureCount; i++) {
        temporalReprojectMix = blend;

        accumulatedTexel[i].a = max(accumulatedTexel[i].a, 1.0);
        if (!constantBlend) temporalReprojectMix = min(1. - 1. / accumulatedTexel[i].a, maxValue);

        outputColor = mix(inputTexel[i].rgb, accumulatedTexel[i].rgb, temporalReprojectMix);

        gOutput[i] = vec4(undoColorTransform(outputColor), accumulatedTexel[i].a);
    }
#pragma unroll_loop_end

// the user's shader to compose a final outputColor from the inputTexel and accumulatedTexel
#ifdef useCustomComposeShader
    customComposeShader
#endif
}