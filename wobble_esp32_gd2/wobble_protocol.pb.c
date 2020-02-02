/* Automatically generated nanopb constant definitions */
/* Generated by nanopb-0.4.0 */

#include "wobble_protocol.pb.h"
#if PB_PROTO_HEADER_VERSION != 40
#error Regenerate this file with the current version of nanopb generator.
#endif

PB_BIND(UndefinedMessage, UndefinedMessage, AUTO)


PB_BIND(StreamInfo, StreamInfo, 2)


PB_BIND(OpenStream, OpenStream, 2)


PB_BIND(ChannelData, ChannelData, 2)


PB_BIND(WriteFrame, WriteFrame, 4)


PB_BIND(CloseStream, CloseStream, AUTO)


PB_BIND(SubscribeStreamList, SubscribeStreamList, AUTO)


PB_BIND(PublishStream, PublishStream, 2)


PB_BIND(Subscribe, Subscribe, AUTO)


PB_BIND(Unsubscribe, Unsubscribe, AUTO)


PB_BIND(PublishFrame, PublishFrame, 4)


PB_BIND(QueryFrames, QueryFrames, AUTO)




#ifndef PB_CONVERT_DOUBLE_FLOAT
/* On some platforms (such as AVR), double is really float.
 * To be able to encode/decode double on these platforms, you need.
 * to define PB_CONVERT_DOUBLE_FLOAT in pb.h or compiler command line.
 */
PB_STATIC_ASSERT(sizeof(double) == 8, DOUBLE_MUST_BE_8_BYTES)
#endif

