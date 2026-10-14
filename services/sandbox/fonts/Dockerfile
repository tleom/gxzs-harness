# Build against an extracted private package-local-fonts.py archive directory.
# Pass the resulting immutable image as WORKBENCH_FONT_IMAGE when building the sandbox.
FROM scratch
ARG FONT_PACK_GENERATION
LABEL org.gxzs.workbench.font-generation=$FONT_PACK_GENERATION
COPY --chmod=0644 fonts/ /fonts/
COPY --chmod=0644 manifest.json /fonts/manifest.json
